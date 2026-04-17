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

  const isDemoMode = result.provider === 'mock' || (!result.provider && !result.midi_url?.includes('/api/download/'))

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
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Result</h2>
            {isDemoMode && (
              <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                Demo Mode
              </span>
            )}
            {result.provider === 'musicgen' && (
              <span className="inline-flex items-center rounded-full bg-indigo-100 dark:bg-indigo-900/30 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-400">
                MusicGen
              </span>
            )}
            {result.provider === 'minimax' && (
              <span className="inline-flex items-center rounded-full bg-purple-100 dark:bg-purple-900/30 px-2 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-400">
                MiniMax + Vocals
              </span>
            )}
          </div>
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

      {/* Demo Mode notice */}
      {isDemoMode && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-4 py-3">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            <span className="font-medium">Demo Mode</span> — using the mock MIDI generator. Set{' '}
            <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">MIDI_GEN_PROVIDER=auto</code>{' '}
            and configure{' '}
            <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">REPLICATE_API_TOKEN</code> or{' '}
            <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">MINIMAX_API_KEY</code>{' '}
            to use real AI generation.
          </p>
        </div>
      )}

      {/* Vocal Track section (MiniMax) */}
      {result.vocal_audio_url && (
        <div className="rounded-xl border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950/20 px-4 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-purple-900 dark:text-purple-200">Vocal Track</p>
              <p className="text-xs text-purple-600 dark:text-purple-400">
                Audio only — import as an audio track in your DAW alongside the .mid file
              </p>
            </div>
            <a href={result.vocal_audio_url} download="voxmidi-vocals.mp3">
              <Button plain>Download vocals.mp3</Button>
            </a>
          </div>
          <audio
            controls
            src={result.vocal_audio_url}
            className="w-full h-10 rounded-lg"
          />
          <p className="text-xs text-purple-500 dark:text-purple-500">
            DAW tip: Import the <strong>.mid</strong> for editable instruments, then drag <strong>vocals.mp3</strong> onto a separate audio track.
          </p>
        </div>
      )}

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
