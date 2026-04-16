import { useState } from 'react'
import PianoRoll from './PianoRoll'
import MidiPlayer from './MidiPlayer'
import TrackMixer from './TrackMixer'
import { Button } from '@/components/catalyst/button'

export default function ResultPanel({ result }) {
  const [mutedTracks, setMutedTracks] = useState(new Set())
  const [soloTrack, setSoloTrack] = useState(null)
  const [playheadSecs, setPlayheadSecs] = useState(0)

  if (!result) return null

  const effectiveMuted = soloTrack !== null
    ? new Set((result.tracks || []).map((_, i) => i).filter(i => i !== soloTrack))
    : mutedTracks

  const totalDuration = (result.tracks || []).reduce((max, track) => {
    const trackMax = (track.notes || []).reduce((m, n) => Math.max(m, n.end || 0), 0)
    return Math.max(max, trackMax)
  }, 10)

  function handleClientDownload() {
    import('@/lib/api').then(({ downloadMidiClientSide }) => {
      downloadMidiClientSide(result.tracks || [], result.tempo || 120)
    })
  }

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
          {result.midi_url ? (
            <a href={result.midi_url} download="voxmidi-output.mid">
              <Button color="indigo">Download .mid</Button>
            </a>
          ) : (
            <Button color="indigo" onClick={handleClientDownload}>Download .mid</Button>
          )}
        </div>
      </div>

      {/* MIDI Player */}
      <MidiPlayer
        tracks={result.tracks || []}
        tempo={result.tempo || 120}
        effectiveMuted={effectiveMuted}
        onPositionChange={setPlayheadSecs}
      />

      {/* PianoRoll + TrackMixer grid */}
      <div className="grid gap-4 lg:grid-cols-[1fr_220px]">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-950 p-2">
          <PianoRoll
            tracks={result.tracks || []}
            tempo={result.tempo || 120}
            duration={totalDuration}
            height={280}
            mutedTracks={effectiveMuted}
            playheadSecs={playheadSecs}
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
