// Studio playback engine: WebAudio synth voices, a lookahead scheduler, and an
// offline renderer that uses the same voices, so an exported mix is exactly
// what plays in the app.

import { totalBars, BEATS_PER_BAR, isDrums } from './project'

// ─── Performance: swing, humanize, rolls and flams ───────────────────────────
// Deterministic (hash-based, not random) so playback and export always match.

function hash01(a, b) {
  let h = Math.imul((a * 1000) | 0, 2654435761) ^ Math.imul(b | 0, 1597334677)
  h = Math.imul(h ^ (h >>> 15), 2246822507)
  h ^= h >>> 13
  return ((h >>> 0) % 10000) / 10000
}

export function performDrums(notes, swing = 0, humanize = 0) {
  const out = []
  const s = swing / 100
  const h = humanize / 100
  for (const n of notes) {
    let t = n.t
    const frac = ((t % 1) + 1) % 1
    if (Math.abs(frac - 0.5) < 0.03) t += s * (1 / 6)          // swung 8th offbeat
    else if (Math.abs((frac % 0.5) - 0.25) < 0.03) t += s * (1 / 12) // swung 16th offbeat
    if (h) {
      t += (hash01(n.t, n.p) - 0.5) * 0.06 * h
      t = Math.max(0, t)
    }
    const v = h ? Math.max(1, Math.min(127, Math.round(n.v + (hash01(n.p, n.t * 7) - 0.5) * 40 * h))) : n.v
    if (n.roll) {
      for (let k = 0; k < 3; k++) out.push({ ...n, t: t + k / 12, d: 1 / 12, v: Math.round(v * (0.7 + k * 0.15)) })
    } else if (n.flam) {
      out.push({ ...n, t: Math.max(0, t - 0.04), v: Math.round(v * 0.5) })
      out.push({ ...n, t, v })
    } else {
      out.push({ ...n, t, v })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

// The scheduler asks for these every 25ms; recompute only when the notes or
// the swing/humanize settings actually change
const performed = new WeakMap()

export function performedNotes(project, track) {
  if (track.kind !== 'midi') return []
  if (!isDrums(track)) return track.notes
  const hit = performed.get(track.notes)
  if (hit && hit.swing === project.swing && hit.humanize === project.humanize) return hit.notes
  const notes = performDrums(track.notes, project.swing, project.humanize)
  performed.set(track.notes, { swing: project.swing, humanize: project.humanize, notes })
  return notes
}

export function audibleTracks(project) {
  const anySolo = project.tracks.some((t) => t.solo)
  return project.tracks.filter((t) => !t.mute && (!anySolo || t.solo))
}

// Master bus limiter: a full band plus vocals sums well past 0 dBFS, so catch
// peaks before they clip, live and in the export alike
function masterBus(ctx) {
  const gain = ctx.createGain()
  gain.gain.value = 0.85
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -6
  limiter.knee.value = 3
  limiter.ratio.value = 20
  limiter.attack.value = 0.002
  limiter.release.value = 0.12
  gain.connect(limiter)
  limiter.connect(ctx.destination)
  return gain
}

// ─── Voices ──────────────────────────────────────────────────────────────────

const SYNTH = {
  // wave, attack, release tail, lowpass, level, detune pair, sub octave
  'Warm bass':    ['sine', 0.006, 0.28, 420, 0.8, false, true],
  'Sub 808':      ['sine', 0.004, 0.9, 260, 0.95, false, false],
  'Picked bass':  ['sawtooth', 0.003, 0.18, 900, 0.5, false, true],
  'Round synth':  ['triangle', 0.01, 0.3, 700, 0.7, true, false],
  'Felt piano':   ['triangle', 0.005, 0.9, 2200, 0.3, true, false],
  'Rhodes':       ['sine', 0.004, 1.2, 3000, 0.36, true, false],
  'Soft pad':     ['sawtooth', 0.25, 1.4, 1400, 0.16, true, false],
  'Plucked keys': ['square', 0.002, 0.35, 2600, 0.18, false, false],
  'Bell lead':    ['sine', 0.002, 1.3, 6000, 0.3, true, false],
  'Breath synth': ['triangle', 0.08, 0.9, 1800, 0.28, true, false],
}

const KITS = {
  'Tight kit':    { kick: [150, 44, 0.26], snareHz: 2000, snareDecay: 0.17, hatDecay: 0.045, tone: 1 },
  'Trap kit':     { kick: [120, 38, 0.7], snareHz: 1800, snareDecay: 0.14, hatDecay: 0.035, tone: 1 },
  'Dusty breaks': { kick: [140, 50, 0.3], snareHz: 1400, snareDecay: 0.2, hatDecay: 0.06, tone: 0.55 },
  'Room kit':     { kick: [160, 48, 0.36], snareHz: 1900, snareDecay: 0.28, hatDecay: 0.08, tone: 1 },
}

const freq = (p) => 440 * Math.pow(2, (p - 69) / 12)

function env(g, t, a, d, peak) {
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(Math.max(0.0001, peak), t + a)
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d)
}

function impulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
  }
  return buf
}

export class Voices {
  constructor(ctx, destination) {
    this.ctx = ctx
    this.dest = destination
    this.trackOut = {}
    const len = Math.floor(ctx.sampleRate * 0.2)
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
  }

  // One gain per track (volume, mute, solo), plus an effect chain for audio tracks
  output(track) {
    let out = this.trackOut[track.id]
    if (!out || out.sound !== track.sound) {
      if (out) out.gain.disconnect()
      const gain = this.ctx.createGain()
      let head = gain
      if (track.kind === 'audio' && /verb/.test(track.sound)) {
        const wet = this.ctx.createGain(); wet.gain.value = 0.35
        const conv = this.ctx.createConvolver()
        conv.buffer = impulse(this.ctx, track.sound === 'Plate verb' ? 2.2 : 1.1, track.sound === 'Plate verb' ? 2.5 : 3.5)
        head = this.ctx.createGain()
        head.connect(gain); head.connect(conv); conv.connect(wet); wet.connect(gain)
      } else if (track.kind === 'audio' && track.sound === 'Warm tape') {
        const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6500
        const shaper = this.ctx.createWaveShaper()
        const curve = new Float32Array(1024)
        for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6) }
        shaper.curve = curve
        head = shaper; shaper.connect(lp); lp.connect(gain)
      }
      gain.connect(this.dest)
      out = { gain, head, sound: track.sound }
      this.trackOut[track.id] = out
    }
    return out
  }

  setLevels(project) {
    const audible = new Set(audibleTracks(project).map((t) => t.id))
    for (const t of project.tracks) {
      const out = this.output(t)
      const v = audible.has(t.id) ? t.vol / 100 : 0
      out.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
    }
  }

  drum(track, n, t) {
    const ctx = this.ctx
    const kit = KITS[track.sound] || KITS['Tight kit']
    const g = ctx.createGain()
    g.connect(this.output(track).head)
    const v = n.v / 127
    if (n.p === 36) {
      const o = ctx.createOscillator()
      o.frequency.setValueAtTime(kit.kick[0], t)
      o.frequency.exponentialRampToValueAtTime(kit.kick[1], t + 0.11)
      env(g, t, 0.002, kit.kick[2], v)
      o.connect(g); o.start(t); o.stop(t + kit.kick[2] + 0.2)
      return
    }
    const s = ctx.createBufferSource(); s.buffer = this.noise
    const f = ctx.createBiquadFilter()
    if (n.p === 38 || n.p === 39) {
      f.type = 'bandpass'; f.frequency.value = n.p === 39 ? kit.snareHz * 0.75 : kit.snareHz; f.Q.value = 0.7
      env(g, t, 0.002, n.p === 39 ? 0.13 : kit.snareDecay, v * 0.6)
    } else if (n.p === 46) {
      f.type = 'highpass'; f.frequency.value = 6500 * kit.tone; env(g, t, 0.002, 0.22, v * 0.3)
    } else if (n.p === 75) {
      f.type = 'bandpass'; f.frequency.value = 3800; f.Q.value = 2; env(g, t, 0.001, 0.06, v * 0.3)
    } else {
      f.type = 'highpass'; f.frequency.value = 7800 * kit.tone; env(g, t, 0.001, kit.hatDecay, v * 0.3)
    }
    s.connect(f); f.connect(g); s.start(t)
  }

  note(track, n, t, bpm) {
    if (isDrums(track)) return this.drum(track, n, t)
    const ctx = this.ctx
    const [type, atk, tail, cut, base, pair, sub] = SYNTH[track.sound] || SYNTH['Felt piano']
    const dur = Math.max(0.08, (n.d * 60) / bpm)
    const g = ctx.createGain()
    g.connect(this.output(track).head)
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cut; f.connect(g)
    const stopAt = t + dur + tail + 0.1
    const o1 = ctx.createOscillator(); o1.type = type
    o1.frequency.setValueAtTime(freq(n.p), t)
    if (n.glide) o1.frequency.exponentialRampToValueAtTime(freq(n.p - 5), t + dur * 0.8)
    o1.connect(f); o1.start(t); o1.stop(stopAt)
    if (pair) { const o2 = ctx.createOscillator(); o2.type = type; o2.frequency.value = freq(n.p) * 1.004; o2.connect(f); o2.start(t); o2.stop(stopAt) }
    if (sub) { const o3 = ctx.createOscillator(); o3.type = 'sine'; o3.frequency.value = freq(n.p) / 2; o3.connect(f); o3.start(t); o3.stop(stopAt) }
    env(g, t, atk, dur + tail, (n.v / 127) * base * 1.6)
  }

  clip(track, buffer, when, offset, duration) {
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.output(track).head)
    src.start(when, Math.max(0, offset), Math.max(0, duration))
    return src
  }

  click(t, strong) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain()
    o.type = 'square'; o.frequency.value = strong ? 1800 : 1200
    g.gain.setValueAtTime(0.09, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04)
    o.connect(g); g.connect(this.dest); o.start(t); o.stop(t + 0.06)
  }
}

// ─── Live engine ─────────────────────────────────────────────────────────────

export class Engine {
  constructor() {
    this.ctx = null
    this.playing = false
    this.listeners = new Set()
    this.takes = new Map() // takeId -> AudioBuffer
  }

  context() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)()
      this.master = masterBus(this.ctx)
      this.voices = new Voices(this.ctx, this.master)
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
    return this.ctx
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setProject(project) {
    this.project = project
    if (this.voices && project) this.voices.setLevels(project)
  }

  range() {
    const p = this.project
    const end = totalBars(p.sections) * BEATS_PER_BAR
    return this.loop ? [this.loop[0], Math.min(this.loop[1], end)] : [0, end]
  }

  beatAt(time) {
    return (time - this.startCtx) / this.spb + this.startBeat
  }

  // opts: { from, loop: [lo, hi] | null, metronome, onEnd }
  play(project, opts = {}) {
    this.stop()
    const ctx = this.context()
    this.setProject(project)
    this.loop = opts.loop || null
    this.metronome = !!opts.metronome
    this.onEnd = opts.onEnd
    this.spb = 60 / project.tempo
    const [lo] = this.range()
    this.startBeat = opts.from ?? lo
    this.startCtx = (opts.at ?? ctx.currentTime) + 0.06
    this.schedTo = this.startBeat
    this.sources = []
    this.playing = true
    this.timer = setInterval(this.pump, 25)
    this.pump()
    this.raf = requestAnimationFrame(this.tick)
    return this.startCtx
  }

  pump = () => {
    if (!this.playing) return
    const p = this.project
    const ctx = this.ctx
    const [lo, hi] = this.range()
    const now = this.beatAt(ctx.currentTime)
    const end = Math.min(now + 0.35 / this.spb, hi)
    if (this.schedTo < end) {
      const from = this.schedTo
      const at = (b) => this.startCtx + (b - this.startBeat) * this.spb
      for (const tr of p.tracks) {
        if (tr.kind === 'midi') {
          for (const n of performedNotes(p, tr)) if (n.t >= from && n.t < end) this.voices.note(tr, n, at(n.t), p.tempo)
        } else {
          for (const c of tr.clips || []) {
            const buf = this.takes.get(c.takeId)
            if (!buf) continue
            const clipEnd = c.startBeat + (c.duration / this.spb)
            // Starts inside this window, or playback began in the middle of it
            if (c.startBeat >= from && c.startBeat < end) {
              this.sources.push(this.voices.clip(tr, buf, at(c.startBeat), c.offset, Math.min(c.duration, (hi - c.startBeat) * this.spb)))
            } else if (from === this.startBeat && c.startBeat < from && clipEnd > from) {
              const into = (from - c.startBeat) * this.spb
              this.sources.push(this.voices.clip(tr, buf, at(from), c.offset + into, Math.min(c.duration - into, (hi - from) * this.spb)))
            }
          }
        }
      }
      if (this.metronome) for (let b = Math.ceil(from); b < end; b++) this.voices.click(at(b), b % 4 === 0)
      this.schedTo = end
    }
    if (now >= hi - 0.02) {
      if (this.loop) {
        this.startCtx = ctx.currentTime + 0.02
        this.startBeat = lo
        this.schedTo = lo
      } else {
        const cb = this.onEnd
        this.stop()
        cb?.()
      }
    }
  }

  tick = () => {
    if (!this.playing) return
    const [lo, hi] = this.range()
    const b = Math.min(hi, Math.max(lo, this.beatAt(this.ctx.currentTime)))
    for (const fn of this.listeners) fn(b)
    this.raf = requestAnimationFrame(this.tick)
  }

  stop() {
    clearInterval(this.timer)
    cancelAnimationFrame(this.raf)
    const wasPlaying = this.playing
    this.playing = false
    for (const s of this.sources || []) { try { s.stop() } catch { /* already stopped */ } }
    this.sources = []
    if (this.ctx && wasPlaying) {
      // Cut ringing tails
      const t = this.ctx.currentTime
      this.master.gain.setValueAtTime(0, t)
      this.master.gain.setValueAtTime(0.85, t + 0.06)
    }
    for (const fn of this.listeners) fn(null)
  }

  audition(track, n) {
    const ctx = this.context()
    if (this.project) this.voices.setLevels(this.project)
    this.voices.note(track, { d: 0.5, ...n }, ctx.currentTime + 0.01, this.project?.tempo || 120)
  }

  click(at, strong) {
    this.context()
    this.voices.click(at, strong)
  }
}

export const engine = new Engine()

// ─── Offline mixdown ─────────────────────────────────────────────────────────

export async function renderMix(project, takes, sampleRate = 44100) {
  const spb = 60 / project.tempo
  const beats = totalBars(project.sections) * BEATS_PER_BAR
  const seconds = beats * spb + 2
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate)
  const master = masterBus(ctx)
  const voices = new Voices(ctx, master)
  voices.setLevels(project)
  const audible = new Set(audibleTracks(project).map((t) => t.id))
  for (const tr of project.tracks) {
    if (!audible.has(tr.id)) continue
    if (tr.kind === 'midi') {
      for (const n of performedNotes(project, tr)) voices.note(tr, n, n.t * spb, project.tempo)
    } else {
      for (const c of tr.clips || []) {
        const buf = takes.get(c.takeId)
        if (buf) voices.clip(tr, buf, c.startBeat * spb, c.offset, c.duration)
      }
    }
  }
  const out = await ctx.startRendering()
  // Leave 1 dB of headroom: scale down if anything still reaches -1 dBFS
  let peak = 0
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c)
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a }
  }
  const ceiling = 0.891
  if (peak > ceiling) {
    const k = ceiling / peak
    for (let c = 0; c < out.numberOfChannels; c++) {
      const d = out.getChannelData(c)
      for (let i = 0; i < d.length; i++) d[i] *= k
    }
  }
  return out
}
