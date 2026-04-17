import { useState, useRef, useEffect, useCallback } from 'react'
import * as Tone from 'tone'

// GM drum map → synth type
const KICK_PITCHES = new Set([35, 36])
const SNARE_PITCHES = new Set([37, 38, 39, 40])
const HAT_CLOSED_PITCHES = new Set([42, 44])
const HAT_OPEN_PITCHES = new Set([46])
const CYMBAL_PITCHES = new Set([49, 51, 52, 55, 57, 59])

function getDrumType(pitch) {
  if (KICK_PITCHES.has(pitch)) return 'kick'
  if (SNARE_PITCHES.has(pitch)) return 'snare'
  if (HAT_CLOSED_PITCHES.has(pitch)) return 'hat_closed'
  if (HAT_OPEN_PITCHES.has(pitch)) return 'hat_open'
  if (CYMBAL_PITCHES.has(pitch)) return 'cymbal'
  return 'snare' // fallback
}

function buildSynths() {
  // Kick — deep membrane
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.06,
    octaves: 6,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.1 },
    volume: 2,
  }).toDestination()

  // Snare — bandpass noise burst
  const snare = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.05 },
    volume: -4,
  }).connect(new Tone.Filter(2500, 'bandpass').toDestination())

  // Closed hi-hat — very short, bright
  const hatClosed = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.02 },
    volume: -10,
  }).connect(new Tone.Filter(8000, 'highpass').toDestination())

  // Open hi-hat — longer decay
  const hatOpen = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.1 },
    volume: -10,
  }).connect(new Tone.Filter(7000, 'highpass').toDestination())

  // Cymbal — long, washy
  const cymbal = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.8, sustain: 0, release: 0.4 },
    volume: -14,
  }).connect(new Tone.Filter(6000, 'highpass').toDestination())

  // Bass — MonoSynth with low filter
  const bass = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    filter: { type: 'lowpass', frequency: 400, Q: 2 },
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.3 },
    filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.3, baseFrequency: 200, octaves: 3 },
    volume: -4,
  }).toDestination()

  // Lead melody — bright PolySynth
  const lead = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle8' },
    envelope: { attack: 0.02, decay: 0.1, sustain: 0.5, release: 0.6 },
    volume: -8,
  }).toDestination()

  // Pads/chords — softer PolySynth with longer release
  const pad = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.08, decay: 0.2, sustain: 0.7, release: 1.2 },
    volume: -12,
  }).toDestination()

  return { kick, snare, hatClosed, hatOpen, cymbal, bass, lead, pad }
}

function disposeSynths(synths) {
  if (!synths) return
  for (const s of Object.values(synths)) {
    try { s.dispose() } catch {}
  }
}

function chooseSynth(track, synths) {
  if (track.is_drum || track.channel === 9) return null // handled per-note
  const name = (track.name || '').toLowerCase()
  const prog = track.program ?? 0
  if (name.includes('bass') || (prog >= 32 && prog <= 39)) return synths.lead  // using lead for bass too (MonoSynth can clash with chords)
  if (name.includes('chord') || name.includes('pad') || (prog >= 88 && prog <= 95)) return synths.pad
  return synths.lead
}

function buildParts(tracks, effectiveMuted, synths, tempo) {
  const parts = []

  tracks.forEach((track, idx) => {
    if (effectiveMuted.has(idx)) return
    const notes = track.notes || []
    if (notes.length === 0) return

    const isDrum = track.is_drum || track.channel === 9

    if (isDrum) {
      // Route each drum note to the right synth
      const events = notes.map(n => ({
        time: n.start,
        pitch: n.pitch,
        velocity: Math.min((n.velocity || 80) / 127, 1),
        duration: Math.max(n.end - n.start - 0.01, 0.03),
      }))

      const part = new Tone.Part((time, ev) => {
        const type = getDrumType(ev.pitch)
        const vel = ev.velocity
        try {
          if (type === 'kick') {
            synths.kick.triggerAttackRelease('C1', '8n', time, vel)
          } else if (type === 'snare') {
            synths.snare.triggerAttackRelease('16n', time, vel)
          } else if (type === 'hat_closed') {
            synths.hatClosed.triggerAttackRelease('32n', time, vel * 0.7)
          } else if (type === 'hat_open') {
            synths.hatOpen.triggerAttackRelease('8n', time, vel * 0.6)
          } else {
            synths.cymbal.triggerAttackRelease('4n', time, vel * 0.5)
          }
        } catch {}
      }, events.map(e => [e.time, e]))

      part.start(0)
      parts.push(part)
    } else {
      const synth = chooseSynth(track, synths)
      if (!synth) return

      const isBass = (track.name || '').toLowerCase().includes('bass') ||
        ((track.program ?? 0) >= 32 && (track.program ?? 0) <= 39)

      const events = notes.map(n => ({
        time: n.start,
        note: Tone.Frequency(n.pitch, 'midi').toNote(),
        duration: Math.max(n.end - n.start - 0.02, 0.05),
        velocity: Math.min((n.velocity || 80) / 127, 1),
      }))

      const useSynth = isBass ? synths.bass : synth

      const part = new Tone.Part((time, ev) => {
        try {
          useSynth.triggerAttackRelease(ev.note, ev.duration, time, ev.velocity)
        } catch {}
      }, events.map(e => [e.time, e]))

      part.start(0)
      parts.push(part)
    }
  })

  return parts
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function PlayIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M5.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75A.75.75 0 007.25 3h-1.5zM12.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75a.75.75 0 00-.75-.75h-1.5z" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M4 4a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V5a1 1 0 00-1-1H4z" clipRule="evenodd" />
    </svg>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MidiPlayer({ tracks = [], tempo = 120, effectiveMuted = new Set(), onPositionChange }) {
  const [state, setState] = useState('stopped') // 'stopped' | 'playing' | 'paused'
  const [position, setPosition] = useState(0)    // seconds
  const synthsRef = useRef(null)
  const partsRef = useRef([])
  const rafRef = useRef(null)
  const stateRef = useRef('stopped')

  const duration = tracks.reduce((max, t) => {
    const end = (t.notes || []).reduce((m, n) => Math.max(m, n.end || 0), 0)
    return Math.max(max, end)
  }, 0) || 10

  // Keep stateRef in sync for rAF callback
  stateRef.current = state

  function stopRaf() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }

  function startRaf() {
    stopRaf()
    function tick() {
      if (stateRef.current !== 'playing') return
      const secs = Tone.getTransport().seconds
      setPosition(secs)
      onPositionChange?.(secs)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  function teardown() {
    stopRaf()
    partsRef.current.forEach(p => { try { p.stop(); p.dispose() } catch {} })
    partsRef.current = []
    disposeSynths(synthsRef.current)
    synthsRef.current = null
    try {
      Tone.getTransport().stop()
      Tone.getTransport().cancel()
      Tone.getTransport().position = 0
    } catch {}
  }

  // Rebuild when tracks/mute change (but not during playback — user must stop first)
  // Teardown on unmount
  useEffect(() => {
    return () => teardown()
  }, [])

  // Stop if result changes entirely (tracks reference changes)
  useEffect(() => {
    teardown()
    setState('stopped')
    setPosition(0)
    onPositionChange?.(0)
  }, [tracks])

  async function handlePlay() {
    if (state === 'playing') {
      // Pause
      Tone.getTransport().pause()
      stopRaf()
      setState('paused')
      return
    }

    if (state === 'paused') {
      // Resume
      Tone.getTransport().start()
      setState('playing')
      startRaf()
      return
    }

    // Fresh start
    teardown()

    await Tone.start()
    Tone.getTransport().bpm.value = tempo

    synthsRef.current = buildSynths()
    partsRef.current = buildParts(tracks, effectiveMuted, synthsRef.current, tempo)

    // Schedule auto-stop
    Tone.getTransport().scheduleOnce(() => {
      setState('stopped')
      setPosition(0)
      onPositionChange?.(0)
      stopRaf()
      Tone.getTransport().stop()
    }, duration + 0.5)

    Tone.getTransport().start()
    setState('playing')
    startRaf()
  }

  function handleStop() {
    teardown()
    setState('stopped')
    setPosition(0)
    onPositionChange?.(0)
  }

  // Seek on progress bar click
  function handleSeek(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const secs = pct * duration

    const wasPlaying = state === 'playing'
    if (wasPlaying) Tone.getTransport().pause()

    Tone.getTransport().seconds = secs
    setPosition(secs)
    onPositionChange?.(secs)

    if (wasPlaying) Tone.getTransport().start()
  }

  const pct = duration > 0 ? (position / duration) * 100 : 0
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-3 flex flex-col gap-3">
      {/* Controls row */}
      <div className="flex items-center gap-3">
        {/* Play / Pause */}
        <button
          onClick={handlePlay}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-white shadow hover:bg-indigo-500 active:bg-indigo-700 transition"
          title={state === 'playing' ? 'Pause' : 'Play'}
        >
          {state === 'playing' ? <PauseIcon /> : <PlayIcon />}
        </button>

        {/* Stop */}
        <button
          onClick={handleStop}
          disabled={state === 'stopped'}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-30 transition"
          title="Stop"
        >
          <StopIcon />
        </button>

        {/* Progress bar */}
        <div
          className="flex-1 h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full cursor-pointer group relative overflow-hidden"
          onClick={handleSeek}
        >
          <div
            className="h-full bg-indigo-500 rounded-full transition-none"
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Time */}
        <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400 tabular-nums w-24 text-right shrink-0">
          {fmt(position)} / {fmt(duration)}
        </span>

        {/* Tempo */}
        <span className="text-xs text-zinc-400 dark:text-zinc-500 tabular-nums shrink-0">
          {tempo} BPM
        </span>
      </div>

      {/* Status */}
      {state === 'playing' && (
        <p className="text-xs text-indigo-500 dark:text-indigo-400 animate-pulse">
          ♪ Playing - mute/solo tracks in the mixer
        </p>
      )}
      {state === 'paused' && (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">Paused - click play to resume</p>
      )}
    </div>
  )
}
