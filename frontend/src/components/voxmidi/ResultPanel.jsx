import { useState, useRef, useEffect } from 'react'
import * as Tone from 'tone'
import PianoRoll from './PianoRoll'
import TrackMixer from './TrackMixer'
import { Button } from '@/components/catalyst/button'

function PlayIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M5.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75A.75.75 0 007.25 3h-1.5zM12.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75a.75.75 0 00-.75-.75h-1.5z" />
    </svg>
  )
}

export default function ResultPanel({ result }) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [mutedTracks, setMutedTracks] = useState(new Set())
  const [soloTrack, setSoloTrack] = useState(null)
  const synthsRef = useRef([])
  const partsRef = useRef([])

  if (!result) return null

  const effectiveMuted = soloTrack !== null
    ? new Set((result.tracks || []).map((_, i) => i).filter(i => i !== soloTrack))
    : mutedTracks

  const totalDuration = (result.tracks || []).reduce((max, track) => {
    const trackMax = (track.notes || []).reduce((m, n) => Math.max(m, n.end || 0), 0)
    return Math.max(max, trackMax)
  }, 10)

  async function handlePlayPause() {
    if (isPlaying) {
      Tone.getTransport().pause()
      setIsPlaying(false)
      return
    }

    await Tone.start()

    // Dispose existing
    partsRef.current.forEach(p => { try { p.stop(); p.dispose() } catch {} })
    synthsRef.current.forEach(s => { try { s.dispose() } catch {} })
    partsRef.current = []
    synthsRef.current = []

    Tone.getTransport().cancel()
    Tone.getTransport().stop()

    const visibleTracks = (result.tracks || []).filter((_, i) => {
      if (soloTrack !== null) return i === soloTrack
      return !mutedTracks.has(i)
    })

    visibleTracks.forEach((track) => {
      let synth
      if (track.is_drum) {
        synth = new Tone.MembraneSynth({
          pitchDecay: 0.05,
          octaves: 4,
          envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 },
        }).toDestination()
      } else {
        synth = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'triangle' },
          envelope: { attack: 0.02, decay: 0.1, sustain: 0.6, release: 0.8 },
          volume: -6,
        }).toDestination()
      }

      const notes = (track.notes || []).map(n => ({
        time: n.start,
        note: Tone.Frequency(n.pitch, 'midi').toNote(),
        duration: Math.max(n.end - n.start - 0.01, 0.05),
        velocity: Math.min((n.velocity || 80) / 127, 1),
      }))

      if (notes.length === 0) return

      const part = new Tone.Part((time, ev) => {
        try {
          synth.triggerAttackRelease(ev.note, ev.duration, time, ev.velocity)
        } catch {}
      }, notes.map(n => [n.time, n]))

      part.start(0)
      synthsRef.current.push(synth)
      partsRef.current.push(part)
    })

    // Stop at end
    const duration = (result.tracks || []).reduce((max, t) => {
      const trackEnd = (t.notes || []).reduce((m, n) => Math.max(m, n.end), 0)
      return Math.max(max, trackEnd)
    }, 10)

    Tone.getTransport().scheduleOnce(() => {
      setIsPlaying(false)
    }, duration + 0.5)

    Tone.getTransport().start()
    setIsPlaying(true)
  }

  function handleClientDownload() {
    import('@/lib/api').then(({ downloadMidiClientSide }) => {
      downloadMidiClientSide(result.tracks || [], result.tempo || 120)
    })
  }

  // Stop on unmount
  useEffect(() => {
    return () => {
      try {
        Tone.getTransport().stop()
        partsRef.current.forEach(p => { try { p.stop(); p.dispose() } catch {} })
        synthsRef.current.forEach(s => { try { s.dispose() } catch {} })
      } catch {}
    }
  }, [])

  // Stop and re-setup when result changes
  useEffect(() => {
    setIsPlaying(false)
    try {
      Tone.getTransport().stop()
      partsRef.current.forEach(p => { try { p.stop(); p.dispose() } catch {} })
      synthsRef.current.forEach(s => { try { s.dispose() } catch {} })
    } catch {}
    partsRef.current = []
    synthsRef.current = []
  }, [result])

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Result</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {result.tracks?.length || 0} tracks · {result.tempo} BPM · {result.key || '?'} · {result.genre || ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Play/Pause button */}
          <Button plain onClick={handlePlayPause}>
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
            {isPlaying ? 'Pause' : 'Play'}
          </Button>
          {/* Download */}
          {result.midi_url ? (
            <a href={result.midi_url} download="voxmidi-output.mid">
              <Button color="indigo">Download .mid</Button>
            </a>
          ) : (
            <Button color="indigo" onClick={handleClientDownload}>Download .mid</Button>
          )}
        </div>
      </div>

      {/* PianoRoll + TrackMixer grid */}
      <div className="grid gap-4 lg:grid-cols-[1fr_220px]">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-950 p-2">
          <PianoRoll
            tracks={result.tracks || []}
            tempo={result.tempo || 120}
            duration={totalDuration}
            height={280}
            mutedTracks={effectiveMuted}
          />
        </div>
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
          <TrackMixer
            tracks={result.tracks || []}
            mutedTracks={mutedTracks}
            onMutedTracksChange={setMutedTracks}
            soloTrack={soloTrack}
            onSoloTrackChange={setSoloTrack}
          />
        </div>
      </div>

      {/* DAW tips */}
      <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 px-4 py-3">
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-medium">Open in your DAW:</span>{' '}
          GarageBand → File → Import MIDI · Ableton → drag to Arrangement · FL Studio → File → Import MIDI · Logic → File → Import
        </p>
      </div>
    </div>
  )
}
