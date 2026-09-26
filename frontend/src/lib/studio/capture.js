// Microphone capture with sample timing on the AudioContext clock, so a take
// can be lined up with the song and the latency measurement uses exactly the
// same path it later corrects.

const WORKLET = `
class VoxCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.len = 0; this.start = null }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      if (this.start === null) this.start = currentTime
      this.buf.push(ch.slice(0)); this.len += ch.length
      if (this.len >= 4096) {
        const out = new Float32Array(this.len); let o = 0
        for (const b of this.buf) { out.set(b, o); o += b.length }
        this.port.postMessage({ start: this.start, data: out }, [out.buffer])
        this.buf = []; this.len = 0; this.start = null
      }
    }
    return true
  }
}
registerProcessor('vox-capture', VoxCapture)
`

const loaded = new WeakSet()

async function ensureWorklet(ctx) {
  if (loaded.has(ctx)) return
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)
  loaded.add(ctx)
}

export async function openMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })
}

export async function listInputs() {
  const devs = await navigator.mediaDevices.enumerateDevices()
  return devs.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }))
}

// Records a source node. stop() returns { samples, startTime, sampleRate },
// where startTime is the context time of samples[0].
export async function startCapture(ctx, source) {
  await ensureWorklet(ctx)
  const node = new AudioWorkletNode(ctx, 'vox-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
  const sink = ctx.createGain()
  sink.gain.value = 0
  source.connect(node)
  node.connect(sink)
  sink.connect(ctx.destination)
  const chunks = []
  node.port.onmessage = (e) => chunks.push(e.data)
  return {
    stop() {
      source.disconnect(node)
      node.disconnect()
      sink.disconnect()
      node.port.onmessage = null
      if (!chunks.length) return { samples: new Float32Array(0), startTime: ctx.currentTime, sampleRate: ctx.sampleRate }
      const startTime = chunks[0].start
      const total = chunks.reduce((a, c) => a + c.data.length, 0)
      const samples = new Float32Array(total)
      // Place each chunk by its own timestamp so a dropped block can't shift later audio
      for (const c of chunks) {
        const at = Math.round((c.start - startTime) * ctx.sampleRate)
        if (at >= 0 && at + c.data.length <= total) samples.set(c.data, at)
      }
      return { samples, startTime, sampleRate: ctx.sampleRate }
    },
  }
}

// Play loud clicks through the speakers, listen for them on the mic, and
// return the median round trip in milliseconds (null if they weren't heard).
export async function measureLatency(ctx, source) {
  const cap = await startCapture(ctx, source)
  const t0 = ctx.currentTime + 0.3
  const clicks = [0, 0.4, 0.8, 1.2, 1.6].map((d) => t0 + d)
  for (const t of clicks) {
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.type = 'square'; o.frequency.value = 1500
    g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.05)
  }
  await new Promise((r) => setTimeout(r, (t0 - ctx.currentTime + 2.1) * 1000))
  const { samples, startTime, sampleRate } = cap.stop()
  const idx = (t) => Math.round((t - startTime) * sampleRate)

  // Noise floor from the quiet stretch before the first click
  const pre = samples.subarray(Math.max(0, idx(t0 - 0.25)), Math.max(0, idx(t0 - 0.02)))
  let floor = 0
  for (const s of pre) floor = Math.max(floor, Math.abs(s))
  const threshold = Math.max(0.02, floor * 4)

  const found = []
  for (const t of clicks) {
    const a = Math.max(0, idx(t - 0.005)), b = Math.min(samples.length, idx(t + 0.3))
    for (let i = a; i < b; i++) {
      if (Math.abs(samples[i]) > threshold) { found.push((i / sampleRate + startTime - t) * 1000); break }
    }
  }
  if (found.length < 3) return null
  found.sort((x, y) => x - y)
  return Math.round(found[Math.floor(found.length / 2)])
}

export function toBuffer(ctx, samples, sampleRate) {
  const buf = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate)
  buf.copyToChannel(samples, 0)
  return buf
}
