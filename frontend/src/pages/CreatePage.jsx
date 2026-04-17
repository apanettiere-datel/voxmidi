import { useState, useRef, useEffect, useCallback } from 'react'

import { startGenerateMidi } from '@/lib/api'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs, JobsNotificationBar } from '@/lib/JobsContext'
import VoicePanel from '@/components/voxmidi/VoicePanel'
import ResultPanel from '@/components/voxmidi/ResultPanel'
import PianoPanel from '@/components/voxmidi/PianoPanel'

const HISTORY_KEY = 'voxmidi_prompt_history'
function getPromptHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}
function savePromptHistory(prompt) {
  if (!prompt.trim()) return
  const h = [prompt, ...getPromptHistory().filter((p) => p !== prompt)].slice(0, 10)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h))
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GENRES = [
  { id: 'edm', label: 'EDM' },
  { id: 'lo-fi-hip-hop', label: 'Lo-fi' },
  { id: 'trap', label: 'Trap' },
  { id: 'house', label: 'House' },
  { id: 'drum-and-bass', label: 'DnB' },
  { id: 'synthwave', label: 'Synthwave' },
  { id: 'pop', label: 'Pop' },
  { id: 'rock', label: 'Rock' },
  { id: 'jazz', label: 'Jazz' },
  { id: 'ambient', label: 'Ambient' },
  { id: 'r-and-b', label: 'R&B' },
  { id: 'classical', label: 'Classical' },
  { id: 'custom', label: 'Custom...' },
]

const KEYS = ['C', 'Cm', 'C#', 'C#m', 'D', 'Dm', 'Eb', 'Ebm', 'E', 'Em', 'F', 'Fm', 'F#', 'F#m', 'G', 'Gm', 'Ab', 'Abm', 'A', 'Am', 'Bb', 'Bbm', 'B', 'Bm']

const GENRE_DEFAULTS = {
  edm: { tempo: 128, key: 'Am' },
  'lo-fi-hip-hop': { tempo: 85, key: 'Cm' },
  trap: { tempo: 140, key: 'Fm' },
  house: { tempo: 124, key: 'Gm' },
  'drum-and-bass': { tempo: 174, key: 'Am' },
  synthwave: { tempo: 108, key: 'Em' },
  pop: { tempo: 120, key: 'C' },
  rock: { tempo: 130, key: 'Em' },
  jazz: { tempo: 110, key: 'Dm' },
  ambient: { tempo: 70, key: 'D' },
  'r-and-b': { tempo: 90, key: 'Bbm' },
  classical: { tempo: 100, key: 'C' },
  metal: { tempo: 140, key: 'Dm' },
}

// Silent prompt auto-detection — fills Advanced Settings without affecting MiniMax prompt
function detectFromPrompt(text) {
  const lower = text.toLowerCase()
  const result = { genre: null, tempo: null, key: null }

  // BPM detection
  const bpmMatch = lower.match(/\b(\d{2,3})\s*(?:bpm)\b/) || lower.match(/\bat\s+(\d{2,3})\b/)
  if (bpmMatch) {
    const bpm = parseInt(bpmMatch[1], 10)
    if (bpm >= 60 && bpm <= 220) result.tempo = bpm
  }

  // Key detection
  const keyMatch = text.match(/\bin\s+(?:the\s+key\s+of\s+)?([A-G][b#]?m?)\b/i)
    || text.match(/\bkey\s+of\s+([A-G][b#]?m?)\b/i)
    || text.match(/\b([A-G](?:b|#)?m(?:in(?:or)?)?)\b/)
  if (keyMatch) result.key = keyMatch[1].replace('min', 'm').replace('or', '').replace('minor', 'm')

  // Genre — ordered by specificity (longer matches first)
  const GENRE_KEYWORDS = [
    ['metal',          ['heavy metal','metalcore','death metal','metal']],
    ['metal',          ['deftones','alt metal','alternative metal','slipknot','tool','korn','linkin park']],
    ['rock',           ['rock','punk','grunge','indie rock','alt rock','alternative']],
    ['drum-and-bass',  ['drum and bass','dnb','d&b','drum & bass','liquid dnb']],
    ['lo-fi-hip-hop',  ['lo-fi','lofi','lo fi','chillhop','chill hop','lofi hip hop']],
    ['trap',           ['trap','drill','travis scott','21 savage','future']],
    ['r-and-b',        ['r&b','rnb','r and b','soul','neo soul']],
    ['house',          ['tech house','deep house','progressive house','house','john summit','fisher']],
    ['edm',            ['edm','electronic dance','big room','electro']],
    ['synthwave',      ['synthwave','retrowave','outrun','80s synth','vaporwave']],
    ['jazz',           ['jazz','bebop','swing','bossa nova','jazz fusion']],
    ['ambient',        ['ambient','atmospheric','drone','meditation']],
    ['classical',      ['classical','orchestral','orchestra','symphony','baroque']],
    ['pop',            ['pop','chart']],
  ]
  for (const [genreId, keywords] of GENRE_KEYWORDS) {
    if (keywords.some((kw) => lower.includes(kw))) {
      result.genre = genreId
      break
    }
  }

  // Apply genre defaults if tempo/key not explicitly mentioned
  const defaults = GENRE_DEFAULTS[result.genre || 'pop']
  if (!result.tempo && result.genre) result.tempo = defaults?.tempo || null
  if (!result.key && result.genre) result.key = defaults?.key || null

  return result
}

const STEPS = [
  { key: 'queued',           label: 'Waiting in queue...', icon: '⏳' },
  { key: 'processing',       label: 'Starting...',          icon: '⚙️' },
  { key: 'generating_audio', label: 'Generating audio...',  icon: '🎵' },
  { key: 'complete',         label: 'Done!',                icon: '✅' },
]

// ─── Sub-components ───────────────────────────────────────────────────────────

function ActionButton({ active, onClick, icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all border ${
        active
          ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
          : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400'
      }`}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  )
}

function ProgressArea({ status, error, onCancel }) {
  const step = STEPS.find((s) => s.key === status?.status) || STEPS[1]
  const progress = status?.progress ?? 0

  if (!status && !error) return null

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4">
        <p className="text-sm font-medium text-red-700 dark:text-red-400">⚠️ {error}</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-4">
      {status?.status === 'queued' ? (
        <div className="text-center space-y-2">
          <p className="text-2xl">⏳</p>
          <p className="font-medium text-zinc-900 dark:text-white">{status.message || 'Queued...'}</p>
          <p className="text-sm text-zinc-500">Your job will start as soon as a slot opens up.</p>
          {onCancel && (
            <button onClick={onCancel} className="text-xs text-red-500 hover:underline mt-1">
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-2xl animate-pulse">{step.icon}</span>
              <p className="font-medium text-zinc-900 dark:text-white">{step.label}</p>
            </div>
            {onCancel && (
              <button
                onClick={onCancel}
                className="text-xs text-zinc-400 hover:text-red-500 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1 transition"
              >
                Cancel ✕
              </button>
            )}
          </div>
          <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2">
            <div
              className="bg-indigo-600 h-2 rounded-full transition-all duration-700"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex flex-wrap gap-4">
            {STEPS.filter((s) => s.key !== 'queued').map((s) => {
              const stepIdx = STEPS.findIndex((x) => x.key === status?.status)
              const sIdx    = STEPS.findIndex((x) => x.key === s.key)
              const done    = stepIdx > sIdx
              const current = s.key === status?.status
              return (
                <span
                  key={s.key}
                  className={`text-xs ${
                    done    ? 'text-indigo-600 dark:text-indigo-400 font-medium'
                  : current ? 'text-zinc-900 dark:text-white font-semibold'
                  :           'text-zinc-400 dark:text-zinc-600'
                  }`}
                >
                  {s.icon} {s.label.replace('...', '')}
                </span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function ShortcutModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 p-6 max-w-md w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-white">⌨️ Piano Keyboard Shortcuts</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-xl leading-none">×</button>
        </div>
        <div className="space-y-4 text-sm text-zinc-700 dark:text-zinc-300">
          <div>
            <p className="font-medium text-zinc-500 dark:text-zinc-400 text-xs uppercase tracking-wide mb-1">White Keys</p>
            <div className="font-mono text-xs bg-zinc-50 dark:bg-zinc-800 rounded-lg p-3 grid grid-cols-2 gap-1">
              <span>A → C3</span><span>S → D3</span>
              <span>D → E3</span><span>F → F3</span>
              <span>G → G3</span><span>H → A3</span>
              <span>J → B3</span><span>K → C4</span>
            </div>
          </div>
          <div>
            <p className="font-medium text-zinc-500 dark:text-zinc-400 text-xs uppercase tracking-wide mb-1">Black Keys</p>
            <div className="font-mono text-xs bg-zinc-50 dark:bg-zinc-800 rounded-lg p-3 grid grid-cols-2 gap-1">
              <span>W → C#3</span><span>E → D#3</span>
              <span>T → F#3</span><span>Y → G#3</span>
              <span>U → A#3</span>
            </div>
          </div>
          <div>
            <p className="font-medium text-zinc-500 dark:text-zinc-400 text-xs uppercase tracking-wide mb-1">Controls</p>
            <div className="font-mono text-xs bg-zinc-50 dark:bg-zinc-800 rounded-lg p-3 space-y-1">
              <div><span className="inline-block bg-zinc-200 dark:bg-zinc-700 rounded px-1">Space</span> → Play / Stop</div>
              <div><span className="inline-block bg-zinc-200 dark:bg-zinc-700 rounded px-1">Backspace</span> → Delete last note</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CreatePage() {
  const authFetch = useAuthFetch()
  const { jobs, startJob, removeJob, cancelJob } = useJobs()

  // Core inputs
  const [prompt, setPrompt] = useState('')
  const [audioBlob, setAudioBlob] = useState(null)
  const [sourceFile, setSourceFile] = useState(null)
  const [sourceMode, setSourceMode] = useState('extract') // 'extract' | 'reference'
  const [lyrics, setLyrics] = useState('')

  // Panel open/close
  const [showVoice, setShowVoice] = useState(false)
  const [showLyrics, setShowLyrics] = useState(false)
  const [showPiano, setShowPiano] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Song length
  const [songDuration, setSongDuration] = useState(0) // 0 = default

  // Presets
  const [presets, setPresets] = useState([])
  const [detectedInfo, setDetectedInfo] = useState(null)

  // Vocal mode — driven by active VoicePanel tab (not derived from blob callbacks)
  const [activeVoiceTab, setActiveVoiceTab] = useState('hum') // 'hum' | 'sing' | 'upload'
  const vocalMode = activeVoiceTab === 'sing' ? 'sing' : activeVoiceTab === 'upload' ? 'upload' : 'hum'
  const [autotune, setAutotune] = useState(0)
  const [reverb, setReverb] = useState(0)

  // Piano / chord state
  const [chordProgression, setChordProgression] = useState([])
  const [melodyBlob, setMelodyBlob] = useState(null)

  // Advanced settings
  const [genre, setGenre] = useState('pop')
  const [customGenreText, setCustomGenreText] = useState('')
  const [tempo, setTempo] = useState(120)
  const [musicalKey, setMusicalKey] = useState('Am')
  const [advancedDirty, setAdvancedDirty] = useState(false)

  // Generation state — wired to global context
  const [currentJobId, setCurrentJobId] = useState(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const [lyricsTheme, setLyricsTheme] = useState('')
  const [generatingLyrics, setGeneratingLyrics] = useState(false)
  const [promptHistory, setPromptHistory] = useState([])
  const [showHistory, setShowHistory] = useState(false)
  const [tapPulse, setTapPulse] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const tapTimesRef = useRef([])
  const tapResetRef = useRef(null)

  // ── Load from sessionStorage on mount ────────────────────────────────────
  useEffect(() => {
    // Pending result from notification bar "View →" click
    const pending = sessionStorage.getItem('voxmidi_pending_result')
    if (pending) {
      try { setResult(JSON.parse(pending)) } catch {}
      sessionStorage.removeItem('voxmidi_pending_result')
    }

    // Remix data
    const remixRaw = sessionStorage.getItem('voxmidi_remix')
    if (remixRaw) {
      try {
        const remix = JSON.parse(remixRaw)
        if (remix.prompt) setPrompt(remix.prompt)
        if (remix.genre) setGenre(remix.genre)
        if (remix.tempo) setTempo(remix.tempo)
        if (remix.key) setMusicalKey(remix.key)
        setShowAdvanced(true)
        setAdvancedDirty(true)
      } catch {}
      sessionStorage.removeItem('voxmidi_remix')
    }

    setPromptHistory(getPromptHistory())

    // Load presets
    authFetch('/api/presets')
      .then(r => r.ok ? r.json() : [])
      .then(setPresets)
      .catch(() => {})
  }, [authFetch])

  // ── Silent prompt auto-detection — fills genre/tempo/key when not explicitly set ──
  useEffect(() => {
    if (!prompt.trim()) { setDetectedInfo(null); return }
    const detected = detectFromPrompt(prompt)
    if (!advancedDirty) {
      if (detected.genre && GENRE_DEFAULTS[detected.genre]) setGenre(detected.genre)
      if (detected.tempo) setTempo(detected.tempo)
      if (detected.key) setMusicalKey(detected.key)
    }
    // Build display string
    if (detected.genre || detected.tempo || detected.key) {
      const GENRE_LABEL_MAP = { 'lo-fi-hip-hop': 'Lo-fi', 'drum-and-bass': 'DnB', 'r-and-b': 'R&B', metal: 'Metal', edm: 'EDM', trap: 'Trap', house: 'House', synthwave: 'Synthwave', pop: 'Pop', rock: 'Rock', jazz: 'Jazz', ambient: 'Ambient', classical: 'Classical' }
      const genreLabel = detected.genre ? (GENRE_LABEL_MAP[detected.genre] || detected.genre) : null
      const parts = [genreLabel, detected.tempo ? `${detected.tempo} BPM` : null, detected.key].filter(Boolean)
      setDetectedInfo(parts.length ? parts.join(' - ') : null)
    } else {
      setDetectedInfo(null)
    }
  }, [prompt]) // eslint-disable-line

  // ── Watch global job state for this page's active job ────────────────────
  const currentJob = currentJobId ? jobs[currentJobId] : null

  useEffect(() => {
    if (!currentJob) return
    if (currentJob.status === 'complete') {
      setResult(currentJob.result)
      setIsGenerating(false)
      setCurrentJobId(null)
      removeJob(currentJobId)
    } else if (currentJob.status === 'error') {
      setError(currentJob.error || 'Generation failed. Please try again.')
      setIsGenerating(false)
      setCurrentJobId(null)
    } else if (currentJob.status === 'cancelled') {
      setError('Generation cancelled.')
      setIsGenerating(false)
      setCurrentJobId(null)
    }
  }, [currentJob?.status]) // eslint-disable-line

  async function handleGenerateLyrics() {
    setGeneratingLyrics(true)
    try {
      const formData = new FormData()
      formData.append('theme', lyricsTheme.trim())
      const effectiveGenre = genre === 'custom' ? (customGenreText.trim() || 'pop') : genre
      formData.append('genre', effectiveGenre)
      const res = await authFetch('/api/generate-lyrics', { method: 'POST', body: formData })
      if (!res.ok) throw new Error('Lyrics generation failed')
      const data = await res.json()
      setLyrics(data.lyrics || '')
    } catch (err) {
      console.error('Lyrics generation failed:', err)
    } finally {
      setGeneratingLyrics(false)
    }
  }

  function handleTapTempo() {
    const now = Date.now()
    tapTimesRef.current = [...tapTimesRef.current.filter((t) => now - t < 3000), now]
    setTapPulse(true)
    setTimeout(() => setTapPulse(false), 120)
    clearTimeout(tapResetRef.current)
    tapResetRef.current = setTimeout(() => { tapTimesRef.current = [] }, 3000)
    if (tapTimesRef.current.length >= 2) {
      const intervals = tapTimesRef.current.slice(1).map((t, i) => t - tapTimesRef.current[i])
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length
      setTempo(Math.min(200, Math.max(60, Math.round(60000 / avg))))
    }
  }

  async function analyzeAudio(blobOrFile) {
    try {
      const fd = new FormData()
      fd.append('audio', blobOrFile, blobOrFile.name || 'audio.webm')
      const res = await authFetch('/api/analyze-audio', { method: 'POST', body: fd })
      if (!res.ok) return
      const data = await res.json()
      if (!advancedDirty) {
        if (data.tempo) setTempo(data.tempo)
        if (data.key) setMusicalKey(data.key)
      }
      const parts = [data.tempo ? `${data.tempo} BPM` : null, data.key].filter(Boolean)
      setDetectedInfo(parts.length ? `Audio: ${parts.join(', ')}` : null)
    } catch { /* ignore */ }
  }

  async function handleCancel() {
    if (currentJobId) {
      await cancelJob(currentJobId)
      setIsGenerating(false)
      setCurrentJobId(null)
      setError('Generation cancelled.')
    }
  }

  async function handleGenerate() {
    setError(null)
    setResult(null)
    setIsGenerating(true)

    const effectiveGenre = genre === 'custom' ? (customGenreText.trim() || 'pop') : genre

    if (prompt.trim()) {
      savePromptHistory(prompt)
      setPromptHistory(getPromptHistory())
    }

    try {
      const isReferenceMode = sourceFile && sourceMode === 'reference'
      const formData = new FormData()
      if (isReferenceMode) {
        formData.append('audio', sourceFile, sourceFile.name)
        formData.append('mode', 'source')
      } else if (audioBlob) {
        formData.append('audio', audioBlob, 'recording.webm')
        formData.append('mode', 'voice')
      } else {
        formData.append('mode', 'text')
      }
      formData.append('prompt', prompt)
      formData.append('genre', effectiveGenre)
      formData.append('tempo', String(tempo))
      formData.append('key', musicalKey)
      formData.append('advanced_dirty', advancedDirty ? 'true' : 'false')
      formData.append('vocal_mode', vocalMode)
      formData.append('autotune', String(autotune))
      formData.append('reverb', String(reverb))
      formData.append('duration', String(songDuration))
      if (showLyrics && lyrics.trim()) formData.append('lyrics', lyrics)
      if (chordProgression.length > 0) formData.append('chord_progression', JSON.stringify(chordProgression))
      if (melodyBlob) formData.append('piano_melody', melodyBlob, 'piano_melody.wav')
      const jobData = await startGenerateMidi(formData, authFetch)

      const jobId = jobData.job_id
      setCurrentJobId(jobId)

      startJob(jobId, {
        label: `${effectiveGenre} · ${tempo} BPM${prompt ? ` - "${prompt.slice(0, 40)}"` : ''}`,
        genre: effectiveGenre,
        tempo,
        key: musicalKey,
      })
    } catch (err) {
      setError(err.message)
      setIsGenerating(false)
    }
  }

  const hasPrompt   = prompt.trim().length > 0
  const isReferenceMode = sourceFile && sourceMode === 'reference'
  const isExtractMode   = sourceFile && sourceMode === 'extract'
  const canGenerate = !isGenerating && (hasPrompt || !!audioBlob || !!sourceFile || (showLyrics && lyrics.trim()))

  const generateLabel = () => {
    if (isGenerating) return 'Generating...'
    if (vocalMode === 'sing' && audioBlob) return '🎤 Generate with My Vocals'
    if (showLyrics && lyrics.trim()) return '🎤 Generate Song with Vocals'
    if (isReferenceMode) return '🎵 Generate from Melody Reference'
    if (isExtractMode) return '🔪 Extract & Separate Stems'
    if (sourceFile) return '🎼 Extract & Convert to MIDI'
    if (audioBlob) return '🎵 Generate from Your Melody'
    return '✨ Generate Music'
  }

  // Derive job status for ProgressArea from global context
  const jobStatus = currentJob ? { status: currentJob.status, progress: currentJob.progress, message: currentJob.error } : null

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-5">

      {/* Prompt */}
      {/* Preset pills */}
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button key={p.id} type="button"
              onClick={() => {
                if (p.prompt_prefix) setPrompt(p.prompt_prefix)
                if (p.genre) setGenre(p.genre)
                if (p.tempo) setTempo(p.tempo)
                if (p.key) setMusicalKey(p.key)
                setAdvancedDirty(true)
              }}
              className="rounded-full px-3 py-1 text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 hover:text-indigo-700 dark:hover:text-indigo-300 transition flex items-center gap-1"
            >
              💾 {p.name}
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  authFetch(`/api/presets/${p.id}`, { method: 'DELETE' })
                    .then(() => setPresets((prev) => prev.filter((x) => x.id !== p.id)))
                    .catch(() => {})
                }}
                className="ml-1 text-zinc-400 hover:text-red-500 cursor-pointer"
              >×</span>
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onFocus={() => setShowHistory(promptHistory.length > 0)}
          onBlur={() => setTimeout(() => setShowHistory(false), 150)}
          rows={4}
          placeholder="Describe the music you want... e.g., Tech house like John Summit, 126 BPM, groovy bassline, festival energy"
          className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-3 text-base text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none shadow-sm"
        />
        {showHistory && promptHistory.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg overflow-hidden">
            <p className="px-3 py-2 text-xs text-zinc-400 dark:text-zinc-500 border-b border-zinc-100 dark:border-zinc-800">Recent prompts</p>
            {promptHistory.map((h, i) => (
              <button key={i} type="button" onMouseDown={() => { setPrompt(h); setShowHistory(false) }}
                className="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 hover:text-indigo-700 dark:hover:text-indigo-300 truncate transition">
                {h}
              </button>
            ))}
          </div>
        )}
      </div>
      {detectedInfo && (
        <p className="text-xs text-indigo-500 dark:text-indigo-400 -mt-3">Detected: {detectedInfo}</p>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <ActionButton
          active={showVoice}
          onClick={() => setShowVoice((v) => !v)}
          icon="🎤"
          label={
            vocalMode === 'sing' && audioBlob ? '🎙️ Vocals recorded ✓'
            : vocalMode === 'hum' && audioBlob ? 'Melody recorded ✓'
            : sourceFile ? '📁 Audio uploaded ✓'
            : 'Voice / Audio'
          }
        />
        <ActionButton
          active={showLyrics}
          onClick={() => setShowLyrics((v) => !v)}
          icon="✍️"
          label={lyrics ? 'Lyrics added ✓' : 'Add Lyrics'}
        />
        <ActionButton
          active={showPiano}
          onClick={() => setShowPiano((v) => !v)}
          icon="🎹"
          label={chordProgression.length > 0 ? `Chords: ${chordProgression.join(' - ')}` : melodyBlob ? 'Melody recorded ✓' : 'Piano / Chords'}
        />
      </div>

      {/* Voice / audio panel */}
      {showVoice && (
        <VoicePanel
          lyrics={lyrics}
          onTabChange={setActiveVoiceTab}
          onHumBlob={(blob) => {
            if (blob) { setAudioBlob(blob); setSourceFile(null); analyzeAudio(blob) }
          }}
          onSingBlob={(blob) => {
            if (blob) { setAudioBlob(blob); setSourceFile(null); analyzeAudio(blob) }
          }}
          onUploadFile={(file, mode) => {
            if (!file) { setSourceFile(null); return }
            setSourceFile(file)
            setSourceMode(mode === 'extract' ? 'extract' : 'reference')
            setAudioBlob(null)
            analyzeAudio(file)
          }}
          onAutotuneChange={setAutotune}
          onReverbChange={setReverb}
        />
      )}

      {/* Lyrics panel */}
      {showLyrics && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Lyrics
              <span className="ml-2 text-xs text-indigo-500 font-normal">enables vocal generation via MiniMax</span>
            </label>
          </div>
          {/* Lyric theme — separate from the music style prompt */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">What should the lyrics be about?</label>
            <div className="flex gap-2">
              <input
                value={lyricsTheme}
                onChange={(e) => setLyricsTheme(e.target.value)}
                placeholder="e.g., dancing at night, missing someone, a black cat named Treble"
                className="flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button onClick={handleGenerateLyrics} disabled={generatingLyrics}
                className="text-xs px-3 py-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition font-medium whitespace-nowrap">
                {generatingLyrics ? 'Generating...' : '✨ Write for me'}
              </button>
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">Leave blank to auto-generate based on genre</p>
          </div>
          {songDuration > 0 && lyrics.trim() && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              ⚠️ Lyrics may be trimmed to fit the selected {songDuration >= 60 ? `${songDuration / 60} min` : `${songDuration}s`} duration.
            </p>
          )}
          <textarea value={lyrics} onChange={(e) => setLyrics(e.target.value)} rows={8}
            placeholder={`[Verse]\nYour verse here...\n\n[Chorus]\nYour chorus here...`}
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-mono text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
          />
        </div>
      )}

      {/* Piano / chords panel */}
      {showPiano && (
        <PianoPanel onChordProgressionChange={setChordProgression} onMelodyBlobChange={setMelodyBlob} />
      )}

      {/* Advanced settings */}
      <div>
        <button type="button" onClick={() => setShowAdvanced((v) => !v)}
          className="text-sm text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition flex items-center gap-1">
          <span>⚙️</span>
          <span>{showAdvanced ? 'Hide' : 'Advanced settings'}</span>
          <span className="text-xs">{showAdvanced ? '▲' : '▼'}</span>
        </button>

        {showAdvanced && (
          <div className="mt-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-5">
            {/* Genre */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Genre</label>
              <div className="flex flex-wrap gap-2">
                {GENRES.map((g) => (
                  <button key={g.id} type="button"
                    onClick={() => { setGenre(g.id); setAdvancedDirty(true); const d = GENRE_DEFAULTS[g.id]; if (d) { setTempo(d.tempo); setMusicalKey(d.key) } }}
                    className={`rounded-full px-3 py-1 text-sm font-medium transition ${
                      genre === g.id ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                    }`}>
                    {g.label}
                  </button>
                ))}
              </div>
              {genre === 'custom' && (
                <input
                  value={customGenreText}
                  onChange={(e) => { setCustomGenreText(e.target.value); setAdvancedDirty(true) }}
                  placeholder="e.g., tropical house, afrobeats, bossa nova, hyperpop..."
                  className="mt-2 w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  autoFocus
                />
              )}
            </div>

            {/* Tempo + Key */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Tempo</label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-zinc-900 dark:text-white w-14 text-right">{tempo} BPM</span>
                    <button type="button" onClick={handleTapTempo}
                      className={`text-xs px-2 py-1 rounded transition font-medium select-none ${
                        tapPulse ? 'bg-indigo-600 text-white scale-95' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      }`}>
                      {tapTimesRef.current.length >= 2 ? `${tempo}` : 'TAP'}
                    </button>
                  </div>
                </div>
                <input type="range" min={60} max={200} value={tempo}
                  onChange={(e) => { setTempo(Number(e.target.value)); setAdvancedDirty(true) }} className="w-full accent-indigo-600" />
                <div className="flex justify-between text-xs text-zinc-400 mt-1"><span>60</span><span>200</span></div>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Key</label>
                <select value={musicalKey} onChange={(e) => { setMusicalKey(e.target.value); setAdvancedDirty(true) }}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  {KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Song duration pills */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">Length:</span>
        {[
          { label: '15s', value: 15 },
          { label: '30s', value: 30 },
          { label: '1 min', value: 60 },
          { label: '2 min', value: 120 },
          { label: '4 min', value: 240 },
        ].map(({ label, value }) => (
          <button key={value} type="button"
            onClick={() => setSongDuration(songDuration === value ? 0 : value)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              songDuration === value
                ? 'bg-indigo-600 text-white'
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
            }`}>
            {label}
          </button>
        ))}
        {songDuration > 0 && (
          <button type="button" onClick={() => setSongDuration(0)}
            className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition">
            Clear
          </button>
        )}
      </div>

      {/* Generate button */}
      <button type="button" onClick={handleGenerate} disabled={!canGenerate}
        className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-zinc-200 dark:disabled:bg-zinc-800 disabled:text-zinc-400 dark:disabled:text-zinc-600 disabled:cursor-not-allowed text-white font-semibold py-4 text-base transition-colors shadow-sm">
        {generateLabel()}
      </button>

      {/* Progress */}
      {isGenerating && <ProgressArea status={jobStatus} error={null} onCancel={handleCancel} />}
      {!isGenerating && error && <ProgressArea status={null} error={error} />}

      {/* Results */}
      {result && <ResultPanel result={result} />}

      {/* Keyboard shortcuts help (when piano open) */}
      {showPiano && (
        <button onClick={() => setShowShortcuts(true)} title="Keyboard shortcuts"
          className="fixed bottom-6 right-6 z-40 w-10 h-10 rounded-full bg-zinc-800 dark:bg-zinc-700 text-white shadow-lg hover:bg-zinc-700 dark:hover:bg-zinc-600 flex items-center justify-center text-lg transition">
          ⌨️
        </button>
      )}

      {showShortcuts && <ShortcutModal onClose={() => setShowShortcuts(false)} />}
    </div>
  )
}
