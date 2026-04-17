import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import PianoRoll from './PianoRoll'
import MidiPlayer from './MidiPlayer'
import TrackMixer from './TrackMixer'

const STEM_META = {
  vocals: { icon: '🎤', label: 'Vocals', color: 'purple' },
  bass:   { icon: '🎸', label: 'Bass',   color: 'blue' },
  drums:  { icon: '🥁', label: 'Drums',  color: 'orange' },
  other:  { icon: '🎹', label: 'Other',  color: 'green' },
}

const COLOR_CLASSES = {
  purple: 'bg-purple-50 dark:bg-purple-950/20 border-purple-200 dark:border-purple-800',
  blue:   'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800',
  orange: 'bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-800',
  green:  'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800',
}

function AudioPlayer({ src, label, compact = false }) {
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)

  if (!src) return null

  function toggle() {
    const el = audioRef.current
    if (!el) return
    if (playing) { el.pause(); setPlaying(false) }
    else { el.play().catch(() => {}); setPlaying(true) }
  }

  function fmt(s) {
    const m = Math.floor(s / 60)
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  }

  if (compact) {
    return (
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <audio
          ref={audioRef}
          src={src}
          onTimeUpdate={(e) => setProgress(e.target.currentTime)}
          onDurationChange={(e) => setDuration(e.target.duration)}
          onEnded={() => setPlaying(false)}
        />
        <button
          onClick={toggle}
          className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center text-xs transition"
        >
          {playing ? '⏸' : '▶'}
        </button>
        <input
          type="range" min={0} max={duration || 1} step={0.1} value={progress}
          onChange={(e) => {
            const t = Number(e.target.value)
            if (audioRef.current) audioRef.current.currentTime = t
            setProgress(t)
          }}
          className="flex-1 accent-indigo-600 h-1"
        />
        <span className="text-xs text-zinc-400 flex-shrink-0 tabular-nums w-10 text-right">
          {fmt(progress)}
        </span>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 space-y-3">
      {label && <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">{label}</p>}
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={(e) => setProgress(e.target.currentTime)}
        onDurationChange={(e) => setDuration(e.target.duration)}
        onEnded={() => setPlaying(false)}
      />
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          className="w-11 h-11 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center text-lg transition shadow-sm flex-shrink-0"
        >
          {playing ? '⏸' : '▶'}
        </button>
        <div className="flex-1 space-y-1">
          <input
            type="range" min={0} max={duration || 1} step={0.1} value={progress}
            onChange={(e) => {
              const t = Number(e.target.value)
              if (audioRef.current) audioRef.current.currentTime = t
              setProgress(t)
            }}
            className="w-full accent-indigo-600"
          />
          <div className="flex justify-between text-xs text-zinc-400 tabular-nums">
            <span>{fmt(progress)}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>
        <input
          type="range" min={0} max={1} step={0.05} value={volume}
          onChange={(e) => {
            const v = Number(e.target.value)
            setVolume(v)
            if (audioRef.current) audioRef.current.volume = v
          }}
          title="Volume"
          className="w-16 accent-indigo-600"
        />
      </div>
    </div>
  )
}

export default function ResultPanel({ result, onShare }) {
  const navigate = useNavigate()
  const [mutedTracks, setMutedTracks] = useState(new Set())
  const [soloTrack, setSoloTrack] = useState(null)
  const [playheadSecs, setPlayheadSecs] = useState(0)
  const [showMidiPlayer, setShowMidiPlayer] = useState(false)
  const [shareMsg, setShareMsg] = useState('')
  const [activeVersion, setActiveVersion] = useState(0)

  if (!result) return null

  // When multiple versions exist, the active tab drives audio/stems display
  const versions = result.versions && result.versions.length > 1 ? result.versions : null
  const activeV = versions ? versions[activeVersion] : null
  const displayAudioUrl = activeV ? activeV.audio_url : result.audio_url
  const displayVocalUrl = activeV ? activeV.vocal_audio_url : result.vocal_audio_url
  const displayStems = activeV ? activeV.stems : (result.stems || {})

  const effectiveMuted =
    soloTrack !== null
      ? new Set((result.tracks || []).map((_, i) => i).filter((i) => i !== soloTrack))
      : mutedTracks

  const totalDuration = (result.tracks || []).reduce((max, track) => {
    const trackMax = (track.notes || []).reduce((m, n) => Math.max(m, n.end || 0), 0)
    return Math.max(max, trackMax)
  }, 10)

  // Only show "Demo Mode" when the backend explicitly used the mock provider
  const isDemoMode = result.provider === 'mock'

  const stems = displayStems
  const hasAudioStems = Object.values(stems).some((url) => typeof url === 'string' && url.endsWith('.mp3'))

  function handleClientDownload() {
    import('@/lib/api').then(({ downloadMidiClientSide }) => {
      downloadMidiClientSide(result.tracks || [], result.tempo || 120)
    })
  }

  async function handleShare() {
    const url = `${window.location.origin}/share/${result.job_id}`
    try {
      await navigator.clipboard.writeText(url)
      setShareMsg('Link copied!')
      setTimeout(() => setShareMsg(''), 3000)
    } catch {
      setShareMsg(url)
    }
  }

  function handleRemix() {
    sessionStorage.setItem('voxmidi_remix', JSON.stringify({
      prompt: result.prompt || '',
      genre: result.genre || 'pop',
      tempo: result.tempo || 120,
      key: result.key || 'Am',
    }))
    navigate('/')
  }

  const costTotal = result.replicate_cost || 0

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Your Result</h2>
            {result.provider === 'musicgen' && (
              <span className="inline-flex items-center rounded-full bg-indigo-100 dark:bg-indigo-900/30 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-400">MusicGen</span>
            )}
            {result.provider === 'minimax' && (
              <span className="inline-flex items-center rounded-full bg-purple-100 dark:bg-purple-900/30 px-2 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-400">MiniMax · Vocals</span>
            )}
            {isDemoMode && (
              <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">Demo Mode</span>
            )}
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {result.tracks?.length || 0} tracks · {result.tempo} BPM · {result.key || '?'} · {result.genre || ''}
            {result.prompt && <span className="ml-1 italic">· "{result.prompt}"</span>}
          </p>
          {costTotal > 0 && (
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
              Cost: ${costTotal.toFixed(3)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleRemix}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
          >
            🔀 Remix
          </button>
          <button
            onClick={handleShare}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
          >
            🔗 Share
          </button>
          {shareMsg && (
            <span className="text-xs text-indigo-600 dark:text-indigo-400">{shareMsg}</span>
          )}
        </div>
      </div>

      {/* Demo mode notice — only shown for actual mock generations */}
      {isDemoMode && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-4 py-3">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            <span className="font-medium">Demo Mode</span> — using the mock MIDI generator. Configure{' '}
            <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">REPLICATE_API_TOKEN</code> or{' '}
            <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">MINIMAX_API_KEY</code>{' '}
            to enable real AI generation.
          </p>
        </div>
      )}

      {/* Version tabs — shown when multiple versions were generated */}
      {versions && (
        <div className="flex gap-2 flex-wrap">
          {versions.map((v, i) => (
            <button
              key={v.id}
              onClick={() => setActiveVersion(i)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition border ${
                activeVersion === i
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}

      {/* Full mix audio player */}
      {displayAudioUrl ? (
        <AudioPlayer src={displayAudioUrl} label="🎵 Full Mix" />
      ) : isDemoMode ? (
        <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700 p-4 text-center text-sm text-zinc-400">
          Audio preview not available in demo mode
        </div>
      ) : null}

      {/* Vocal track (MiniMax) */}
      {displayVocalUrl && (
        <AudioPlayer src={displayVocalUrl} label="🎤 Vocal Track" />
      )}

      {/* Stems section */}
      {hasAudioStems && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Separated Stems</h3>
            <a
              href={`/api/download/${result.job_id}/stems.zip`}
              download
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 text-xs font-medium transition"
            >
              📦 Download All (.zip)
            </a>
          </div>
          <div className="space-y-2">
            {Object.entries(stems).map(([stem, url]) => {
              if (!url || typeof url !== 'string') return null
              const meta = STEM_META[stem] || { icon: '🎵', label: stem, color: 'green' }
              return (
                <div
                  key={stem}
                  className={`flex items-center gap-3 rounded-xl border p-3 ${COLOR_CLASSES[meta.color] || COLOR_CLASSES.green}`}
                >
                  <span className="text-lg flex-shrink-0">{meta.icon}</span>
                  <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 w-14 flex-shrink-0">
                    {meta.label}
                  </span>
                  <AudioPlayer src={url} compact />
                  <a
                    href={url}
                    download={`${stem}.mp3`}
                    className="flex-shrink-0 text-xs text-zinc-500 dark:text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                    title={`Download ${meta.label}`}
                  >
                    ↓
                  </a>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Download buttons */}
      <div className="flex flex-wrap gap-3">
        {result.midi_url ? (
          <a
            href={result.midi_url}
            download="voxmidi-output.mid"
            className="flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 text-sm font-semibold transition shadow-sm"
          >
            🎹 <span>Download MIDI</span>
            <span className="text-indigo-200 text-xs font-normal">.mid</span>
          </a>
        ) : (
          <button
            onClick={handleClientDownload}
            className="flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 text-sm font-semibold transition shadow-sm"
          >
            🎹 <span>Download MIDI</span>
            <span className="text-indigo-200 text-xs font-normal">.mid</span>
          </button>
        )}

        {displayAudioUrl && (
          <a
            href={displayAudioUrl}
            download="voxmidi-output.mp3"
            className="flex items-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 text-sm font-semibold transition shadow-sm"
          >
            🎵 <span>Download Audio</span>
            <span className="text-emerald-200 text-xs font-normal">.mp3</span>
          </a>
        )}

        {hasAudioStems && (
          <a
            href={`/api/download/${result.job_id}/stems.zip`}
            download
            className="flex items-center gap-2 rounded-xl bg-zinc-700 hover:bg-zinc-600 text-white px-4 py-2.5 text-sm font-semibold transition shadow-sm"
          >
            📦 <span>All Stems</span>
            <span className="text-zinc-300 text-xs font-normal">.zip</span>
          </a>
        )}

        {displayVocalUrl && (
          <a
            href={displayVocalUrl}
            download="voxmidi-vocals.mp3"
            className="flex items-center gap-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white px-4 py-2.5 text-sm font-semibold transition shadow-sm"
          >
            🎤 <span>Vocals</span>
            <span className="text-purple-200 text-xs font-normal">.mp3</span>
          </a>
        )}
      </div>

      {result.midi_url && (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 pl-1">
          🎹 Edit in GarageBand, Ableton, FL Studio, Logic · 🎵 Listen or share
        </p>
      )}

      {/* MIDI section */}
      <div className="border-t border-zinc-100 dark:border-zinc-800 pt-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">🎹 Editable MIDI</h3>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              {result.key} · {result.tempo} BPM · edit in any DAW
            </p>
          </div>
          <button
            onClick={() => setShowMidiPlayer((v) => !v)}
            className="text-xs text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 underline"
          >
            {showMidiPlayer ? 'Hide preview' : 'MIDI preview'}
          </button>
        </div>

        {showMidiPlayer && (
          <>
            <MidiPlayer
              tracks={result.tracks || []}
              tempo={result.tempo || 120}
              effectiveMuted={effectiveMuted}
              onPositionChange={setPlayheadSecs}
            />
            <div className="grid gap-4 lg:grid-cols-[1fr_220px]">
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-950 p-2 overflow-x-auto">
                <PianoRoll
                  tracks={result.tracks || []}
                  tempo={result.tempo || 120}
                  duration={totalDuration}
                  height={240}
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
          </>
        )}
      </div>

      {/* DAW tips */}
      <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 px-4 py-3">
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-medium">Import MIDI:</span>{' '}
          GarageBand → File → Import · Ableton → drag to Arrangement ·
          FL Studio → File → Import · Logic → File → Import
        </p>
      </div>
    </div>
  )
}
