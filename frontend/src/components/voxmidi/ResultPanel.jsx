import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthFetch } from '@/lib/authFetch'
import { separateStems, getJobStatus } from '@/lib/api'
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
  const [loop, setLoop] = useState(false)

  if (!src) return null

  function toggle() {
    const el = audioRef.current
    if (!el) return
    if (playing) { el.pause(); setPlaying(false) }
    else { el.play().catch(() => {}); setPlaying(true) }
  }

  function toggleLoop() {
    const next = !loop
    setLoop(next)
    if (audioRef.current) audioRef.current.loop = next
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
          loop={loop}
          onTimeUpdate={(e) => setProgress(e.target.currentTime)}
          onDurationChange={(e) => setDuration(e.target.duration)}
          onEnded={() => { if (!loop) setPlaying(false) }}
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
        <button
          onClick={toggleLoop}
          title="Loop"
          className={`flex-shrink-0 text-sm transition ${loop ? 'text-indigo-500' : 'text-zinc-300 dark:text-zinc-600 hover:text-zinc-500'}`}
        >
          🔁
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 space-y-3">
      {label && <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">{label}</p>}
      <audio
        ref={audioRef}
        src={src}
        loop={loop}
        onTimeUpdate={(e) => setProgress(e.target.currentTime)}
        onDurationChange={(e) => setDuration(e.target.duration)}
        onEnded={() => { if (!loop) setPlaying(false) }}
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
        <button
          onClick={toggleLoop}
          title="Loop"
          className={`text-lg transition flex-shrink-0 ${loop ? 'text-indigo-500' : 'text-zinc-300 dark:text-zinc-600 hover:text-zinc-500'}`}
        >
          🔁
        </button>
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
  const authFetch = useAuthFetch()
  const [mutedTracks, setMutedTracks] = useState(new Set())
  const [soloTrack, setSoloTrack] = useState(null)
  const [playheadSecs, setPlayheadSecs] = useState(0)
  const [showMidiPlayer, setShowMidiPlayer] = useState(false)
  const [shareMsg, setShareMsg] = useState('')
  const [activeVersion, setActiveVersion] = useState(0)
  const [stemsSepState, setStemsSepState] = useState('idle') // 'idle'|'loading'|'done'|'error'
  const [stemsOverride, setStemsOverride] = useState(null)
  const [extensions, setExtensions] = useState([]) // [{job_id, audio_url, duration, loading, error}]
  const [concatUrl, setConcatUrl] = useState(null)
  const [concatLoading, setConcatLoading] = useState(false)
  const [playAllActive, setPlayAllActive] = useState(false)
  const [savePresetMsg, setSavePresetMsg] = useState('')
  const pollRef = useRef(null)
  const extPollRefs = useRef({})
  const playAllRefs = useRef([]) // array of audio element refs for sequential play

  useEffect(() => () => {
    clearInterval(pollRef.current)
    Object.values(extPollRefs.current).forEach(clearInterval)
  }, [])

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

  const stems = stemsOverride !== null ? stemsOverride : displayStems
  const hasAudioStems = Object.values(stems).some((url) => typeof url === 'string' && url.endsWith('.mp3'))

  async function handleSeparateStems() {
    if (!result?.job_id) return
    setStemsSepState('loading')
    try {
      const data = await separateStems(result.job_id, authFetch)
      const sepJobId = data.sep_job_id
      if (data.status === 'already_done' || !sepJobId) {
        setStemsSepState('done')
        return
      }
      clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const status = await getJobStatus(sepJobId, authFetch)
          if (!status) return
          if (status.status === 'complete' && status.result?.stems) {
            clearInterval(pollRef.current)
            setStemsOverride(status.result.stems)
            setStemsSepState('done')
          } else if (status.status === 'error') {
            clearInterval(pollRef.current)
            setStemsSepState('error')
          }
        } catch { /* poll silently */ }
      }, 3000)
    } catch {
      setStemsSepState('error')
    }
  }

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

  async function handleExtend(sourceJobId) {
    const jobIdToExtend = sourceJobId || result?.job_id
    if (!jobIdToExtend) return
    const slotId = `ext_${Date.now()}`
    setExtensions((prev) => [...prev, { slotId, loading: true, error: false }])
    try {
      const res = await authFetch(`/api/extend/${jobIdToExtend}`, { method: 'POST' })
      if (!res.ok) throw new Error('Extend failed')
      const data = await res.json()
      const extJobId = data.ext_job_id
      clearInterval(extPollRefs.current[slotId])
      extPollRefs.current[slotId] = setInterval(async () => {
        try {
          const { getJobStatus } = await import('@/lib/api')
          const status = await getJobStatus(extJobId, authFetch)
          if (!status) return
          if (status.status === 'complete') {
            clearInterval(extPollRefs.current[slotId])
            setExtensions((prev) => prev.map((e) =>
              e.slotId === slotId
                ? { slotId, job_id: extJobId, audio_url: status.result?.audio_url, midi_url: status.result?.midi_url, loading: false, error: false }
                : e
            ))
          } else if (status.status === 'error') {
            clearInterval(extPollRefs.current[slotId])
            setExtensions((prev) => prev.map((e) => e.slotId === slotId ? { ...e, loading: false, error: true } : e))
          }
        } catch { /* poll silently */ }
      }, 3000)
    } catch {
      setExtensions((prev) => prev.map((e) => e.slotId === slotId ? { ...e, loading: false, error: true } : e))
    }
  }

  async function handleDownloadFull() {
    if (!result?.job_id) return
    const doneExts = extensions.filter((e) => !e.loading && !e.error && e.job_id)
    if (!doneExts.length) return
    setConcatLoading(true)
    try {
      const fd = new FormData()
      fd.append('ext_job_id', doneExts[doneExts.length - 1].job_id)
      const res = await authFetch(`/api/concat/${result.job_id}`, { method: 'POST', body: fd })
      if (!res.ok) throw new Error('Concat failed')
      const d = await res.json()
      setConcatUrl(d.audio_url)
    } catch { /* ignore */ }
    finally { setConcatLoading(false) }
  }

  function handlePlayAll() {
    // Sequential playback: original audio + all done extensions
    const urls = [result.audio_url, ...extensions.filter((e) => e.audio_url).map((e) => e.audio_url)].filter(Boolean)
    if (!urls.length) return
    let idx = 0
    setPlayAllActive(true)
    function playNext() {
      if (idx >= urls.length) { setPlayAllActive(false); return }
      const audio = new Audio(urls[idx++])
      audio.onended = playNext
      audio.onerror = playNext
      audio.play().catch(playNext)
    }
    playNext()
  }

  async function handleSavePreset() {
    const name = window.prompt('Preset name:', result.genre || 'My Preset')
    if (!name) return
    try {
      const fd = new FormData()
      fd.append('name', name)
      fd.append('genre', result.genre || 'pop')
      fd.append('tempo', String(result.tempo || 120))
      fd.append('key', result.key || 'Am')
      fd.append('prompt_prefix', result.prompt || '')
      const res = await authFetch('/api/presets', { method: 'POST', body: fd })
      if (!res.ok) throw new Error('Failed')
      setSavePresetMsg('Preset saved!')
      setTimeout(() => setSavePresetMsg(''), 3000)
    } catch {
      setSavePresetMsg('Failed to save preset')
      setTimeout(() => setSavePresetMsg(''), 3000)
    }
  }

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
            {result.prompt && <span className="ml-1 italic">- "{result.prompt}"</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleRemix}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
          >
            🔀 Remix
          </button>
          {result?.audio_url && (
            <button
              onClick={() => handleExtend(null)}
              disabled={extensions.some((e) => e.loading)}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition disabled:opacity-50"
            >
              {extensions.some((e) => e.loading) ? '⏳ Extending...' : '🔄 Extend'}
            </button>
          )}
          <button
            onClick={handleSavePreset}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
          >
            💾 Preset
          </button>
          <button
            onClick={handleShare}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
          >
            🔗 Share
          </button>
          {shareMsg && <span className="text-xs text-indigo-600 dark:text-indigo-400">{shareMsg}</span>}
          {savePresetMsg && <span className="text-xs text-emerald-600 dark:text-emerald-400">{savePresetMsg}</span>}
          {extensions.some((e) => e.error) && <span className="text-xs text-red-500">Extend failed</span>}
        </div>
      </div>

      {/* Demo mode notice — only shown for actual mock generations */}
      {isDemoMode && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-4 py-3">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            <span className="font-medium">Demo Mode</span> - using the mock MIDI generator. Configure{' '}
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

      {/* On-demand stem separation — opt-in checkbox */}
      {!hasAudioStems && result?.audio_url && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
          <label className={`flex items-start gap-3 ${stemsSepState === 'loading' ? 'opacity-60' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={stemsSepState !== 'idle'}
              onChange={(e) => { if (e.target.checked && stemsSepState === 'idle') handleSeparateStems() }}
              disabled={stemsSepState === 'loading'}
              className="mt-0.5 h-4 w-4 rounded accent-indigo-600 flex-shrink-0"
            />
            <div>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Separate into stems
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">Split audio into vocals, bass, drums &amp; other for individual editing</p>
            </div>
          </label>
          {stemsSepState === 'loading' && (
            <div className="flex items-center gap-2 mt-3 ml-7">
              <span className="text-sm leading-none" style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>🔄</span>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Separating stems… this takes ~60 seconds</p>
            </div>
          )}
          {stemsSepState === 'error' && (
            <p className="text-xs text-red-500 dark:text-red-400 mt-2 ml-7">Separation failed. Your full mix is still available above.</p>
          )}
        </div>
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
          GarageBand - File - Import · Ableton - drag to Arrangement ·
          FL Studio - File - Import · Logic - File - Import
        </p>
      </div>

      {/* Extensions timeline */}
      {extensions.length > 0 && (
        <div className="border-t border-zinc-100 dark:border-zinc-800 pt-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">🔄 Extensions</h3>
            <div className="flex items-center gap-2 flex-wrap">
              {extensions.some((e) => !e.loading && !e.error && e.audio_url) && result.audio_url && (
                <>
                  <button
                    onClick={handlePlayAll}
                    disabled={playAllActive}
                    className="rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 text-xs font-semibold transition disabled:opacity-60"
                  >
                    {playAllActive ? '▶ Playing...' : '▶ Play All'}
                  </button>
                  <button
                    onClick={handleDownloadFull}
                    disabled={concatLoading}
                    className="rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 px-3 py-1 text-xs font-medium hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition disabled:opacity-50"
                  >
                    {concatLoading ? '⏳ Merging...' : '📦 Download Full Song'}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Timeline */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <div className="flex-shrink-0 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 px-3 py-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
              Original{result.duration ? ` ${Math.round(result.duration)}s` : ''}
            </div>
            {extensions.map((ext, i) => (
              <div key={ext.slotId} className="flex items-center gap-2 flex-shrink-0">
                <span className="text-zinc-400 dark:text-zinc-600 text-sm">→</span>
                <div className={`rounded-lg border px-3 py-1 text-xs font-medium ${
                  ext.loading ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-400 animate-pulse'
                  : ext.error ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800 text-red-600 dark:text-red-400'
                  : 'bg-emerald-100 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                }`}>
                  {ext.loading ? `Ext ${i + 1} ⏳` : ext.error ? `Ext ${i + 1} ✗` : `Ext ${i + 1}`}
                </div>
              </div>
            ))}
          </div>

          {/* Extension players */}
          {extensions.map((ext, i) => (
            <div key={ext.slotId} className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Extension {i + 1}</p>
                <div className="flex items-center gap-2">
                  {!ext.loading && !ext.error && ext.audio_url && (
                    <button
                      onClick={() => handleExtend(ext.job_id)}
                      disabled={extensions.some((e) => e.loading)}
                      className="text-xs text-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition disabled:opacity-50"
                    >
                      🔄 Extend Again
                    </button>
                  )}
                  {!ext.loading && !ext.error && ext.midi_url && (
                    <a href={ext.midi_url} download={`extension-${i + 1}.mid`}
                      className="text-xs text-zinc-500 hover:text-indigo-500 transition">
                      🎹 MIDI
                    </a>
                  )}
                </div>
              </div>
              {ext.loading && (
                <p className="text-xs text-zinc-400 animate-pulse">Generating extension...</p>
              )}
              {ext.error && (
                <p className="text-xs text-red-500">Extension failed. Try again.</p>
              )}
              {!ext.loading && !ext.error && ext.audio_url && (
                <AudioPlayer src={ext.audio_url} compact />
              )}
            </div>
          ))}

          {concatUrl && (
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 p-3 space-y-2">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">Full Song (original + extensions merged)</p>
              <AudioPlayer src={concatUrl} />
              <a href={concatUrl} download="full-song.mp3"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-xs font-semibold transition">
                ↓ Download Full Song
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
