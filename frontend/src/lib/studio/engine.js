// Studio playback engine: WebAudio synth voices, a lookahead scheduler, and an
// offline renderer that uses the same voices, so an exported mix is exactly
// what plays in the app.

import { isDrums, fxOf, songEndBeats } from './project'

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
  'Rubber bass':  ['triangle', 0.004, 0.22, 520, 0.75, false, true],
  'Growl bass':   ['sawtooth', 0.005, 0.25, 340, 0.65, true, true],
  'Hollow bass':  ['square', 0.004, 0.2, 430, 0.55, false, true],
  'Glass pad':    ['triangle', 0.18, 1.6, 3200, 0.14, true, false],
  'Organ tone':   ['square', 0.01, 0.15, 1800, 0.2, true, false],
  'Saw lead':     ['sawtooth', 0.004, 0.5, 3800, 0.22, true, false],
  'Square lead':  ['square', 0.003, 0.4, 2800, 0.2, false, false],
  // EDM voices: unison stacks and filter-envelope sweeps (last two fields)
  'Supersaw':     ['sawtooth', 0.01, 0.4, 2600, 0.5, false, false, 7, 0.4],
  'Future bass':  ['sawtooth', 0.02, 0.5, 1600, 0.6, false, true, 5, 0.5],
  'EDM pluck':    ['sawtooth', 0.002, 0.3, 1200, 0.42, false, false, 3, 0.9],
  'Reese bass':   ['sawtooth', 0.004, 0.3, 520, 0.6, false, true, 4, 0.3],
  'Hard lead':    ['square', 0.003, 0.35, 3200, 0.3, false, false, 3, 0.6],
  'Saw stab':     ['sawtooth', 0.002, 0.18, 2400, 0.4, false, false, 5, 0.7],
}

const KITS = {
  'Tight kit':    { kick: [150, 44, 0.26], snareHz: 2000, snareDecay: 0.17, hatDecay: 0.045, tone: 1 },
  'Trap kit':     { kick: [120, 38, 0.7], snareHz: 1800, snareDecay: 0.14, hatDecay: 0.035, tone: 1 },
  'Dusty breaks': { kick: [140, 50, 0.3], snareHz: 1400, snareDecay: 0.2, hatDecay: 0.06, tone: 0.55 },
  'Room kit':     { kick: [160, 48, 0.36], snareHz: 1900, snareDecay: 0.28, hatDecay: 0.08, tone: 1 },
  'Lo-fi kit':    { kick: [130, 46, 0.32], snareHz: 1200, snareDecay: 0.16, hatDecay: 0.05, tone: 0.4 },
  '909 kit':      { kick: [180, 52, 0.22], snareHz: 2300, snareDecay: 0.15, hatDecay: 0.04, tone: 1.15 },
  'Boom bap':     { kick: [125, 42, 0.42], snareHz: 1600, snareDecay: 0.22, hatDecay: 0.055, tone: 0.7 },
  'Brush kit':    { kick: [140, 50, 0.2], snareHz: 1500, snareDecay: 0.35, hatDecay: 0.09, tone: 0.5 },
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

  // One gain per track (volume, mute, solo), plus its effect chain: the sound
  // preset (audio tracks), then the four fx knobs (every track). Rebuilt only
  // when the sound or an fx value changes, so slider drags don't glitch notes
  // already playing through the old chain.
  output(track) {
    const fx = fxOf(track)
    const sig = `${track.sound}|${fx.drive}|${fx.tone}|${fx.reverb}|${fx.echo}`
    let out = this.trackOut[track.id]
    if (!out || out.sig !== sig) {
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
      head = this.fxChain(fx, head)
      gain.connect(this.dest)
      out = { gain, head, sig }
      this.trackOut[track.id] = out
    }
    return out
  }

  // The four knobs, in guitar-pedal order: drive -> tone -> (dry + echo + reverb)
  fxChain(fx, into) {
    let head = into
    if (fx.reverb > 0 || fx.echo > 0) {
      const sum = this.ctx.createGain()
      sum.connect(into)
      if (fx.reverb > 0) {
        const conv = this.ctx.createConvolver()
        conv.buffer = this.fxImpulse ||= impulse(this.ctx, 1.8, 3)
        const wet = this.ctx.createGain(); wet.gain.value = (fx.reverb / 100) * 0.55
        sum.connect(conv); conv.connect(wet); wet.connect(into)
      }
      if (fx.echo > 0) {
        const delay = this.ctx.createDelay(1.0); delay.delayTime.value = 0.3
        const fb = this.ctx.createGain(); fb.gain.value = 0.35
        const wet = this.ctx.createGain(); wet.gain.value = (fx.echo / 100) * 0.5
        sum.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(into)
      }
      head = sum
    }
    if (fx.tone !== 50) {
      // One tilt knob: left warms (more lows, fewer highs), right brightens
      const amount = ((fx.tone - 50) / 50) * 8
      const low = this.ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 280; low.gain.value = -amount
      const high = this.ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 2400; high.gain.value = amount
      low.connect(high); high.connect(head)
      head = low
    }
    if (fx.drive > 0) {
      const k = 1 + (fx.drive / 100) * 14
      const shaper = this.ctx.createWaveShaper()
      const curve = new Float32Array(1024)
      for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k) }
      shaper.curve = curve
      // Saturation raises perceived level; trim it back as drive goes up
      const trim = this.ctx.createGain(); trim.gain.value = 1 - (fx.drive / 100) * 0.35
      shaper.connect(trim); trim.connect(head)
      head = shaper
    }
    return head
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
    // wave, attack, tail, lowpass, level, detune pair, sub octave, [unison, filterEnv]
    const [type, atk, tail, cut, base, pair, sub, unison = 1, fenv = 0] = SYNTH[track.sound] || SYNTH['Felt piano']
    const dur = Math.max(0.08, (n.d * 60) / bpm)
    const g = ctx.createGain()
    g.connect(this.output(track).head)
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'
    const stopAt = t + dur + tail + 0.1
    // Filter envelope: open bright on the attack, close down over the note. The
    // signature EDM pluck/supersaw move; fenv 0 keeps the static cutoff.
    if (fenv > 0) {
      const open = Math.min(16000, cut + (cut * 7 + 3000) * fenv)
      f.frequency.setValueAtTime(open, t)
      f.frequency.exponentialRampToValueAtTime(Math.max(120, cut), t + Math.min(dur, 0.06 + dur * 0.5))
      f.Q.value = 2 + fenv * 6
    } else {
      f.frequency.value = cut
    }
    f.connect(g)
    const root = freq(n.p)
    // Unison stack: detuned saws spread around the root make the fat supersaw.
    // One voice is the plain tone; a `pair` adds one gentle detune as before.
    const spread = 14 // cents at the edges of the stack
    const count = Math.max(1, unison)
    for (let i = 0; i < count; i++) {
      const o = ctx.createOscillator(); o.type = type
      const cents = count === 1 ? 0 : (i / (count - 1) - 0.5) * 2 * spread
      o.frequency.setValueAtTime(root * Math.pow(2, cents / 1200), t)
      if (i === 0 && n.glide) o.frequency.exponentialRampToValueAtTime(freq(n.p - 5), t + dur * 0.8)
      o.connect(f); o.start(t); o.stop(stopAt)
    }
    if (pair && unison === 1) { const o2 = ctx.createOscillator(); o2.type = type; o2.frequency.value = root * 1.004; o2.connect(f); o2.start(t); o2.stop(stopAt) }
    if (sub) { const o3 = ctx.createOscillator(); o3.type = 'sine'; o3.frequency.value = root / 2; o3.connect(f); o3.start(t); o3.stop(stopAt) }
    // More unison voices sum louder; scale the level back so a supersaw doesn't clip
    env(g, t, atk, dur + tail, (n.v / 127) * base * 1.6 / Math.sqrt(count))
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
    const end = songEndBeats(p)
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
  const beats = songEndBeats(project)
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
