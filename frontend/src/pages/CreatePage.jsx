import { useState, useRef, useEffect, useCallback } from 'react'

import { startGenerateMidi, startExtractSource, getJobStatus, saveToLibrary } from '@/lib/api'
import { useAuthFetch } from '@/lib/authFetch'
import AudioRecorder from '@/components/voxmidi/AudioRecorder'
import ResultPanel from '@/components/voxmidi/ResultPanel'

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
}

const STEPS = [
  { key: 'queued', label: 'Waiting in queue...', icon: '⏳' },
  { key: 'processing', label: 'Starting...', icon: '⚙️' },
  { key: 'generating_audio', label: 'Generating audio...', icon: '🎵' },
  { key: 'downloading', label: 'Downloading audio...', icon: '⬇️' },
  { key: 'separating_stems', label: 'Separating stems...', icon: '🔄' },
  { key: 'transcribing', label: 'Transcribing to MIDI...', icon: '📝' },
  { key: 'complete', label: 'Done!', icon: '✅' },
]

// ─── Prompt parser (client-side mirror of backend) ────────────────────────────

function parsePrompt(text) {
  const result = { genre: null, tempo: null, key: null }
  const bpmMatch = text.match(/\b(\d{2,3})\s*(?:bpm)\b/i) || text.match(/\bat\s+(\d{2,3})\b/i)
  if (bpmMatch) {
    const bpm = parseInt(bpmMatch[1])
    if (bpm >= 60 && bpm <= 220) result.tempo = bpm
  }
  const keyMatch =
    text.match(/\b(?:in\s+(?:the\s+key\s+of\s+)?|key\s+of\s+)([A-G][b#]?m?)\b/i) ||
    text.match(/\b([A-G][b#]?m)\b/)
  if (keyMatch) result.key = keyMatch[1]

  const genreMap = [
    ['edm', ['edm', 'electronic dance']],
    ['house', ['tech house', 'deep house', 'progressive house', 'house']],
    ['trap', ['trap', 'drill']],
    ['lo-fi-hip-hop', ['lo-fi', 'lofi', 'lo fi', 'chillhop']],
    ['drum-and-bass', ['drum and bass', 'dnb', 'd&b']],
    ['synthwave', ['synthwave', 'retrowave', '80s synth']],
    ['pop', ['pop']],
    ['rock', ['rock']],
    ['jazz', ['jazz', 'bebop', 'swing']],
    ['ambient', ['ambient', 'atmospheric']],
    ['r-and-b', ['r&b', 'rnb', 'soul']],
    ['classical', ['classical', 'orchestral']],
  ]
  const lower = text.toLowerCase()
  for (const [id, kws] of genreMap) {
    if (kws.some((kw) => lower.includes(kw))) {
      result.genre = id
      break
    }
  }
  return result
}

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

function ProgressArea({ status, error }) {
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
        <div className="text-center space-y-1">
          <p className="text-2xl">⏳</p>
          <p className="font-medium text-zinc-900 dark:text-white">{status.message || 'Queued...'}</p>
          <p className="text-sm text-zinc-500">Your job will start as soon as a slot opens up.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-2xl animate-pulse">{step.icon}</span>
            <p className="font-medium text-zinc-900 dark:text-white">{step.label}</p>
          </div>
          <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2">
            <div
              className="bg-indigo-600 h-2 rounded-full transition-all duration-700"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex gap-6">
            {STEPS.filter((s) => s.key !== 'queued').map((s) => {
              const done = STEPS.findIndex((x) => x.key === status?.status) >
                STEPS.findIndex((x) => x.key === s.key)
              const current = s.key === status?.status
              return (
                <span
                  key={s.key}
                  className={`text-xs ${
                    done ? 'text-indigo-600 dark:text-indigo-400 font-medium' :
                    current ? 'text-zinc-900 dark:text-white font-semibold' :
                    'text-zinc-400 dark:text-zinc-600'
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function CreatePage() {
  const authFetch = useAuthFetch()

  // Core inputs
  const [prompt, setPrompt] = useState('')
  const [audioBlob, setAudioBlob] = useState(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourceFile, setSourceFile] = useState(null)
  const [lyrics, setLyrics] = useState('')

  // Panel open/close
  const [showRecorder, setShowRecorder] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [showLyrics, setShowLyrics] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Advanced settings (auto-filled from prompt, user-editable)
  const [genre, setGenre] = useState('pop')
  const [tempo, setTempo] = useState(120)
  const [musicalKey, setMusicalKey] = useState('Am')
  const [trackToggles] = useState({ melody: true, bass: true, chords: true, drums: true })

  // Generation state
  const [jobId, setJobId] = useState(null)
  const [jobStatus, setJobStatus] = useState(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const [generatingLyrics, setGeneratingLyrics] = useState(false)
  const [promptHistory, setPromptHistory] = useState([])
  const [showHistory, setShowHistory] = useState(false)
  const fileInputRef = useRef(null)
  const tapTimesRef = useRef([])
  const pollRef = useRef(null)

  // Load URL from Sources page
  useEffect(() => {
    const url = sessionStorage.getItem('voxmidi_load_source')
    if (url) {
      setSourceUrl(url)
      setShowSource(true)
      sessionStorage.removeItem('voxmidi_load_source')
    }
    setPromptHistory(getPromptHistory())
  }, [])

  // Auto-parse prompt → fill advanced settings (only when advanced is not manually open)
  useEffect(() => {
    if (!prompt.trim() || showAdvanced) return
    const parsed = parsePrompt(prompt)
    if (parsed.genre) {
      setGenre(parsed.genre)
      const defaults = GENRE_DEFAULTS[parsed.genre]
      if (defaults && !parsed.tempo) setTempo(defaults.tempo)
      if (defaults && !parsed.key) setMusicalKey(defaults.key)
    }
    if (parsed.tempo) setTempo(parsed.tempo)
    if (parsed.key) setMusicalKey(parsed.key)
  }, [prompt])

  // Poll job status
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!jobId) return
    pollRef.current = setInterval(async () => {
      try {
        const status = await getJobStatus(jobId, authFetch)
        if (!status) return
        setJobStatus(status)
        if (status.status === 'complete') {
          stopPolling()
          setJobId(null)
          setIsGenerating(false)
          setResult(status.result)
          saveToLibrary(status.result, { genre, tempo, key: musicalKey })
        } else if (status.status === 'error') {
          stopPolling()
          setJobId(null)
          setIsGenerating(false)
          setError(status.message || 'Generation failed. Please try again.')
          setJobStatus(null)
        }
      } catch (e) {
        console.error('Poll error:', e)
      }
    }, 3000)
    return stopPolling
  }, [jobId])

  async function handleGenerateLyrics() {
    setGeneratingLyrics(true)
    try {
      const formData = new FormData()
      formData.append('theme', prompt || genre)
      formData.append('genre', genre)
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
    if (tapTimesRef.current.length >= 2) {
      const intervals = tapTimesRef.current.slice(1).map((t, i) => t - tapTimesRef.current[i])
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length
      setTempo(Math.min(200, Math.max(60, Math.round(60000 / avg))))
    }
  }

  async function handleGenerate() {
    setError(null)
    setResult(null)
    setJobStatus(null)
    setIsGenerating(true)

    if (prompt.trim()) {
      savePromptHistory(prompt)
      setPromptHistory(getPromptHistory())
    }

    try {
      const isSourceMode = sourceFile || (sourceUrl && !sourceUrl.startsWith('file://'))
      let jobData

      if (isSourceMode) {
        const formData = new FormData()
        if (sourceFile) {
          formData.append('file', sourceFile, sourceFile.name)
        } else {
          formData.append('url', sourceUrl)
        }
        formData.append('genre', genre)
        formData.append('tempo', String(tempo))
        formData.append('key', musicalKey)
        jobData = await startExtractSource(formData, authFetch)
      } else {
        const formData = new FormData()
        if (audioBlob) {
          formData.append('audio', audioBlob, 'recording.webm')
          formData.append('mode', 'voice')
        } else {
          formData.append('mode', 'text')
        }
        formData.append('prompt', prompt)
        formData.append('genre', genre)
        formData.append('tempo', String(tempo))
        formData.append('key', musicalKey)
        if (showLyrics && lyrics.trim()) {
          formData.append('lyrics', lyrics)
        }
        jobData = await startGenerateMidi(formData, authFetch)
      }

      setJobId(jobData.job_id)
      setJobStatus({ status: jobData.status || 'processing', progress: 0 })
    } catch (err) {
      setError(err.message)
      setIsGenerating(false)
    }
  }

  const hasPrompt = prompt.trim().length > 0
  const hasSource = !!(sourceFile || (sourceUrl && !sourceUrl.startsWith('file://')))
  const canGenerate = !isGenerating && (hasPrompt || !!audioBlob || hasSource || (showLyrics && lyrics.trim()))

  const generateLabel = () => {
    if (isGenerating) return 'Generating...'
    if (showLyrics && lyrics.trim()) return 'Generate Song with Vocals'
    if (hasSource) return 'Extract & Convert to MIDI'
    if (audioBlob) return 'Generate MIDI from Recording'
    return 'Generate MIDI'
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-5">

      {/* Prompt — hero input */}
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
        {/* Recent prompts dropdown */}
        {showHistory && promptHistory.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg overflow-hidden">
            <p className="px-3 py-2 text-xs text-zinc-400 dark:text-zinc-500 border-b border-zinc-100 dark:border-zinc-800">Recent prompts</p>
            {promptHistory.map((h, i) => (
              <button
                key={i}
                type="button"
                onMouseDown={() => { setPrompt(h); setShowHistory(false) }}
                className="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 hover:text-indigo-700 dark:hover:text-indigo-300 truncate transition"
              >
                {h}
              </button>
            ))}
          </div>
        )}
        {prompt && (
          <p className="mt-1.5 text-xs text-zinc-400 dark:text-zinc-500 pl-1">
            Detected: <span className="text-indigo-500">{genre}</span>
            {' · '}<span className="text-indigo-500">{tempo} BPM</span>
            {' · '}<span className="text-indigo-500">{musicalKey}</span>
          </p>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <ActionButton
          active={showRecorder}
          onClick={() => setShowRecorder((v) => !v)}
          icon="🎤"
          label={audioBlob ? 'Voice recorded ✓' : 'Record Voice'}
        />
        <ActionButton
          active={showSource}
          onClick={() => setShowSource((v) => !v)}
          icon="🔗"
          label={sourceFile ? sourceFile.name : sourceUrl ? 'URL set ✓' : 'Audio Source'}
        />
        <ActionButton
          active={showLyrics}
          onClick={() => setShowLyrics((v) => !v)}
          icon="✍️"
          label={lyrics ? 'Lyrics added ✓' : 'Add Lyrics'}
        />
      </div>

      {/* Voice recorder panel */}
      {showRecorder && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-4">
            Hum a melody, beatbox, or whistle — we'll transcribe it
          </p>
          <AudioRecorder onRecordingComplete={setAudioBlob} />
        </div>
      )}

      {/* Audio source panel */}
      {showSource && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
          {/* File upload — prominent */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              Upload an audio file <span className="font-normal text-zinc-400">(recommended — MP3, WAV, FLAC)</span>
            </label>
            <div
              onClick={() => fileInputRef.current?.click()}
              className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
                sourceFile
                  ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/20'
                  : 'border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
              }`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const f = e.dataTransfer.files[0]
                if (f) { setSourceFile(f); setSourceUrl('') }
              }}
            >
              {sourceFile ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">🎵 {sourceFile.name}</p>
                  <p className="text-xs text-zinc-400">{(sourceFile.size / 1048576).toFixed(1)} MB</p>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setSourceFile(null) }}
                    className="text-xs text-zinc-400 hover:text-red-500 underline"
                  >Remove</button>
                </div>
              ) : (
                <>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">Drop audio here or click to browse</p>
                  <p className="text-xs text-zinc-400 mt-1">MP3, WAV, FLAC, OGG, M4A</p>
                </>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) { setSourceFile(f); setSourceUrl('') }
              }}
            />
          </div>

          {/* URL input */}
          <div>
            <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-2">
              Or paste a YouTube URL{' '}
              <span className="font-normal text-zinc-400">(may be blocked by YouTube)</span>
            </label>
            <input
              type="url"
              value={sourceUrl}
              onChange={(e) => { setSourceUrl(e.target.value); setSourceFile(null) }}
              placeholder="https://www.youtube.com/watch?v=..."
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>
      )}

      {/* Lyrics panel */}
      {showLyrics && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Lyrics
              <span className="ml-2 text-xs text-indigo-500 font-normal">enables vocal generation via MiniMax</span>
            </label>
            <button
              onClick={handleGenerateLyrics}
              disabled={generatingLyrics}
              className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition font-medium"
            >
              {generatingLyrics ? 'Generating...' : '✨ Write lyrics for me'}
            </button>
          </div>
          <textarea
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            rows={8}
            placeholder={`[Verse]\nYour verse here...\n\n[Chorus]\nYour chorus here...`}
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-mono text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
          />
        </div>
      )}

      {/* Advanced settings */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-sm text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition flex items-center gap-1"
        >
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
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => {
                      setGenre(g.id)
                      const d = GENRE_DEFAULTS[g.id]
                      if (d) { setTempo(d.tempo); setMusicalKey(d.key) }
                    }}
                    className={`rounded-full px-3 py-1 text-sm font-medium transition ${
                      genre === g.id
                        ? 'bg-indigo-600 text-white'
                        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tempo + Key */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Tempo</label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-zinc-900 dark:text-white w-14 text-right">{tempo} BPM</span>
                    <button
                      type="button"
                      onClick={handleTapTempo}
                      className="text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition"
                    >TAP</button>
                  </div>
                </div>
                <input
                  type="range"
                  min={60}
                  max={200}
                  value={tempo}
                  onChange={(e) => setTempo(Number(e.target.value))}
                  className="w-full accent-indigo-600"
                />
                <div className="flex justify-between text-xs text-zinc-400 mt-1"><span>60</span><span>200</span></div>
              </div>

              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Key</label>
                <select
                  value={musicalKey}
                  onChange={(e) => setMusicalKey(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </div>
            </div>

            {/* Track toggles */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Tracks</label>
              <div className="flex flex-wrap gap-3">
                {['Melody', 'Bass', 'Chords', 'Drums'].map((t) => (
                  <span
                    key={t}
                    className="rounded-full px-3 py-1 text-sm font-medium bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
                  >
                    ✓ {t}
                  </span>
                ))}
              </div>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">All tracks are always generated for maximum flexibility in your DAW.</p>
            </div>
          </div>
        )}
      </div>

      {/* Generate button */}
      <button
        type="button"
        onClick={handleGenerate}
        disabled={!canGenerate}
        className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-zinc-200 dark:disabled:bg-zinc-800 disabled:text-zinc-400 dark:disabled:text-zinc-600 disabled:cursor-not-allowed text-white font-semibold py-4 text-base transition-colors shadow-sm"
      >
        {generateLabel()}
      </button>

      {/* Progress / error */}
      <ProgressArea status={jobStatus} error={error} />

      {/* Results */}
      {result && (
        <ResultPanel
          result={result}
          onSaveToLibrary={() => saveToLibrary(result, { genre, tempo: result.tempo || tempo, key: result.key || musicalKey })}
        />
      )}
    </div>
  )
}
