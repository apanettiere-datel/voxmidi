import { useState } from 'react'
import PianoRoll from './PianoRoll'
import MidiPlayer from './MidiPlayer'
import TrackMixer from './TrackMixer'

export default function ResultPanel({ result }) {
  const [mutedTracks, setMutedTracks] = useState(new Set())
  const [soloTrack, setSoloTrack] = useState(null)
  const [playheadSecs, setPlayheadSecs] = useState(0)

  if (!result) return null

  const effectiveMuted =
    soloTrack !== null
      ? new Set((result.tracks || []).map((_, i) => i).filter((i) => i !== soloTrack))
      : mutedTracks

  const totalDuration = (result.tracks || []).reduce((max, track) => {
    const trackMax = (track.notes || []).reduce((m, n) => Math.max(m, n.end || 0), 0)
    return Math.max(max, trackMax)
  }, 10)

  const isDemoMode =
    result.provider === 'mock' ||
    (!result.provider && !result.midi_url?.includes('/api/download/'))

  function handleClientDownload() {
    import('@/lib/api').then(({ downloadMidiClientSide }) => {
      downloadMidiClientSide(result.tracks || [], result.tempo || 120)
    })
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Your Result</h2>
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
                MiniMax · Vocals
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {result.tracks?.length || 0} tracks · {result.tempo} BPM · {result.key || '?'} · {result.genre || ''}
          </p>
        </div>
      </div>

      {/* Download buttons */}
      <div className="flex flex-wrap gap-3">
        {result.midi_url ? (
          <a
            href={result.midi_url}
            download="voxmidi-output.mid"
            className="flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 text-sm font-semibold transition-colors shadow-sm"
          >
            <span>🎹</span>
            <span>Download MIDI</span>
            <span className="text-indigo-200 text-xs font-normal">.mid</span>
          </a>
        ) : (
          <button
            onClick={handleClientDownload}
            className="flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 text-sm font-semibold transition-colors shadow-sm"
          >
            <span>🎹</span>
            <span>Download MIDI</span>
            <span className="text-indigo-200 text-xs font-normal">.mid</span>
          </button>
        )}

        {result.audio_url && (
          <a
            href={result.audio_url}
            download="voxmidi-output.mp3"
            className="flex items-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 text-sm font-semibold transition-colors shadow-sm"
          >
            <span>🎵</span>
            <span>Download Audio</span>
            <span className="text-emerald-200 text-xs font-normal">.mp3</span>
          </a>
        )}

        {result.vocal_audio_url && (
          <a
            href={result.vocal_audio_url}
            download="voxmidi-vocals.mp3"
            className="flex items-center gap-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white px-4 py-2.5 text-sm font-semibold transition-colors shadow-sm"
          >
            <span>🎤</span>
            <span>Download Vocals</span>
            <span className="text-purple-200 text-xs font-normal">.mp3</span>
          </a>
        )}
      </div>

      {/* Download subtitles */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-400 dark:text-zinc-500 pl-1">
        <span>🎹 Edit in GarageBand, Ableton, FL Studio</span>
        {result.audio_url && <span>🎵 Listen or share directly</span>}
        {result.vocal_audio_url && <span>🎤 Layer vocals in your DAW</span>}
      </div>

      {/* Demo Mode notice */}
      {isDemoMode && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-4 py-3">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            <span className="font-medium">Demo Mode</span> — using the mock MIDI generator. Configure{' '}
            <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">REPLICATE_API_TOKEN</code> or{' '}
            <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">MINIMAX_API_KEY</code>{' '}
            in your backend <code>.env</code> to enable real AI generation.
          </p>
        </div>
      )}

      {/* Vocal audio player (MiniMax) */}
      {result.vocal_audio_url && (
        <div className="rounded-xl border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950/20 px-4 py-4 space-y-2">
          <p className="text-sm font-medium text-purple-900 dark:text-purple-200">🎤 Vocal Track Preview</p>
          <audio controls src={result.vocal_audio_url} className="w-full h-10 rounded-lg" />
          <p className="text-xs text-purple-500">
            Import the <strong>.mid</strong> for instruments, then drag <strong>vocals.mp3</strong> onto a separate audio track in your DAW.
          </p>
        </div>
      )}

      {/* Generated audio player */}
      {result.audio_url && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 px-4 py-4 space-y-2">
          <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200">🎵 Generated Audio Preview</p>
          <audio controls src={result.audio_url} className="w-full h-10 rounded-lg" />
        </div>
      )}

      {/* MIDI Player */}
      <MidiPlayer
        tracks={result.tracks || []}
        tempo={result.tempo || 120}
        effectiveMuted={effectiveMuted}
        onPositionChange={setPlayheadSecs}
      />

      {/* Piano roll + Track mixer */}
      <div className="grid gap-4 lg:grid-cols-[1fr_220px]">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-950 p-2 overflow-x-auto">
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
          <span className="font-medium">Import into your DAW:</span>{' '}
          GarageBand → File → Import MIDI · Ableton → drag to Arrangement ·
          FL Studio → File → Import MIDI · Logic → File → Import
        </p>
      </div>
    </div>
  )
}
