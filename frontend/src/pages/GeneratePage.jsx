import { useState, useRef, useEffect, useCallback } from 'react'
import { startGenerateMidi, enhancePrompt, aiGenerateLyrics } from '@/lib/api'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import ResultPanel from '@/components/voxmidi/ResultPanel'
import AudioRecorder from '@/components/voxmidi/AudioRecorder'

const GENRES = [
  { id: 'pop', label: 'Pop' },
  { id: 'rock', label: 'Rock' },
  { id: 'edm', label: 'EDM' },
  { id: 'lo-fi-hip-hop', label: 'Lo-fi' },
  { id: 'trap', label: 'Trap' },
  { id: 'house', label: 'House' },
  { id: 'drum-and-bass', label: 'DnB' },
  { id: 'synthwave', label: 'Synthwave' },
  { id: 'jazz', label: 'Jazz' },
  { id: 'ambient', label: 'Ambient' },
  { id: 'r-and-b', label: 'R&B' },
  { id: 'classical', label: 'Classical' },
  { id: 'custom', label: 'Custom...' },
]

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

const KEYS = ['C', 'Cm', 'C#', 'C#m', 'D', 'Dm', 'Eb', 'Ebm', 'E', 'Em', 'F', 'Fm', 'F#', 'F#m', 'G', 'Gm', 'Ab', 'Abm', 'A', 'Am', 'Bb', 'Bbm', 'B', 'Bm']

const STEPS = [
  { key: 'queued', label: 'Waiting in queue...', icon: '...' },
  { key: 'processing', label: 'Starting...', icon: '...' },
  { key: 'generating_audio', label: 'Generating audio...', icon: '...' },
  { key: 'complete', label: 'Done!', icon: '...' },
]

export default function GeneratePage() {
  const authFetch = useAuthFetch()
  const { jobs, startJob, removeJob, cancelJob } = useJobs()

  // Song description
  const [roughPrompt, setRoughPrompt] = useState('')
  const [enhancedPrompt, setEnhancedPrompt] = useState('')
  const [enhancing, setEnhancing] = useState(false)
  const [useEnhanced, setUseEnhanced] = useState(false)

  // Lyrics
  const [lyricsTheme, setLyricsTheme] = useState('')
  const [lyrics, setLyrics] = useState('')
  const [generatingLyrics, setGeneratingLyrics] = useState(false)
  const [instrumental, setInstrumental] = useState(false)

  // Voice reference
  const [voiceBlob, setVoiceBlob] = useState(null)
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false)

  // Settings — genre is null until user explicitly picks one
  const [genre, setGenre] = useState(null)
  const [customGenreText, setCustomGenreText] = useState('')
  const [tempo, setTempo] = useState(120)
  const [musicalKey, setMusicalKey] = useState('Am')
  const [showFineTune, setShowFineTune] = useState(false)
  const [tempoTouched, setTempoTouched] = useState(false)
  const [keyTouched, setKeyTouched] = useState(false)

  // Generation
  const [currentJobId, setCurrentJobId] = useState(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  // Load pending result from notification bar
  useEffect(() => {
    const pending = sessionStorage.getItem('voxmidi_pending_result')
    if (pending) {
      try { setResult(JSON.parse(pending)) } catch {}
      sessionStorage.removeItem('voxmidi_pending_result')
    }
    const remixRaw = sessionStorage.getItem('voxmidi_remix')
    if (remixRaw) {
      try {
        const remix = JSON.parse(remixRaw)
        if (remix.prompt) setRoughPrompt(remix.prompt)
        if (remix.genre) setGenre(remix.genre)
        if (remix.tempo) { setTempo(remix.tempo); setTempoTouched(true) }
        if (remix.key) { setMusicalKey(remix.key); setKeyTouched(true) }
        setShowFineTune(true)
      } catch {}
      sessionStorage.removeItem('voxmidi_remix')
    }
  }, [])

  // Watch job state
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
  }, [currentJob?.status])

  function handleGenreClick(g) {
    if (genre === g.id) {
      setGenre(null)
      return
    }
    setGenre(g.id)
    const d = GENRE_DEFAULTS[g.id]
    if (d && !tempoTouched) setTempo(d.tempo)
    if (d && !keyTouched) setMusicalKey(d.key)
  }

  async function handleEnhance() {
    if (!roughPrompt.trim()) return
    setEnhancing(true)
    setError(null)
    try {
      const effectiveGenre = genre === 'custom' ? (customGenreText.trim() || '') : (genre || '')
      const data = await enhancePrompt(roughPrompt, effectiveGenre, authFetch)
      setEnhancedPrompt(data.enhanced_prompt)
      setUseEnhanced(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setEnhancing(false)
    }
  }

  async function handleGenerateLyrics() {
    setGeneratingLyrics(true)
    setError(null)
    try {
      const effectiveGenre = genre === 'custom' ? (customGenreText.trim() || '') : (genre || '')
      const data = await aiGenerateLyrics(lyricsTheme, effectiveGenre, '', authFetch)
      setLyrics(data.lyrics || '')
    } catch (err) {
      setError(err.message)
    } finally {
      setGeneratingLyrics(false)
    }
  }

  async function handleGenerate() {
    setError(null)
    setResult(null)
    setIsGenerating(true)

    const effectiveGenre = genre === 'custom' ? (customGenreText.trim() || '') : (genre || '')
    const finalPrompt = useEnhanced && enhancedPrompt ? enhancedPrompt : roughPrompt

    try {
      const formData = new FormData()
      formData.append('mode', 'text')
      formData.append('prompt', finalPrompt)
      if (effectiveGenre) formData.append('genre', effectiveGenre)
      if (tempoTouched) formData.append('tempo', String(tempo))
      if (keyTouched) formData.append('key', musicalKey)
      formData.append('advanced_dirty', effectiveGenre || tempoTouched || keyTouched ? 'true' : 'false')
      if (!instrumental && lyrics.trim()) formData.append('lyrics', lyrics)
      if (voiceBlob) formData.append('voice_audio', voiceBlob, 'voice_reference.webm')

      const jobData = await startGenerateMidi(formData, authFetch)
      const jobId = jobData.job_id
      setCurrentJobId(jobId)

      startJob(jobId, {
        label: `${effectiveGenre || 'auto'} · ${tempoTouched ? tempo + ' BPM' : 'auto'}${finalPrompt ? ` - "${finalPrompt.slice(0, 40)}"` : ''}`,
        genre: effectiveGenre,
        tempo,
        key: musicalKey,
      })
    } catch (err) {
      setError(err.message)
      setIsGenerating(false)
    }
  }

  async function handleCancel() {
    if (currentJobId) {
      await cancelJob(currentJobId)
      setIsGenerating(false)
      setCurrentJobId(null)
      setError('Generation cancelled.')
    }
  }

  const canGenerate = !isGenerating && (roughPrompt.trim() || enhancedPrompt.trim() || (!instrumental && lyrics.trim()))
  const jobStatus = currentJob ? { status: currentJob.status, progress: currentJob.progress, message: currentJob.error } : null

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Song Generator</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Describe your song, refine with AI, and generate a finished track
        </p>
      </div>

      {/* Step 1: Describe your song */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold">1</span>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Describe your song</h2>
        </div>

        <textarea
          value={roughPrompt}
          onChange={(e) => { setRoughPrompt(e.target.value); if (useEnhanced) setUseEnhanced(false) }}
          rows={3}
          placeholder="e.g., A chill summer vibe with acoustic guitar and soft vocals, something you'd hear at a beach bonfire"
          className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-3 text-base text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none shadow-sm"
        />

        <div className="flex items-center gap-3">
          <button
            onClick={handleEnhance}
            disabled={enhancing || !roughPrompt.trim()}
            className="rounded-lg bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 px-4 py-2 text-sm font-medium hover:bg-indigo-100 dark:hover:bg-indigo-900/60 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {enhancing ? 'Enhancing...' : 'Enhance with AI'}
          </button>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            AI refines your description into a detailed music prompt
          </span>
        </div>

        {/* Enhanced prompt */}
        {enhancedPrompt && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
                Enhanced prompt {useEnhanced ? '(active)' : '(not used)'}
              </label>
              <button
                onClick={() => setUseEnhanced(!useEnhanced)}
                className={`text-xs px-2.5 py-1 rounded-lg border transition font-medium ${
                  useEnhanced
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white dark:bg-zinc-900 text-zinc-500 border-zinc-200 dark:border-zinc-700 hover:border-indigo-400'
                }`}
              >
                {useEnhanced ? 'Using enhanced' : 'Use enhanced'}
              </button>
            </div>
            <textarea
              value={enhancedPrompt}
              onChange={(e) => setEnhancedPrompt(e.target.value)}
              rows={4}
              className={`w-full rounded-xl border px-4 py-3 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none transition ${
                useEnhanced
                  ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50/50 dark:bg-indigo-950/20'
                  : 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 opacity-60'
              }`}
            />
          </div>
        )}
      </section>

      {/* Step 2: Lyrics */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold">2</span>
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Lyrics</h2>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Instrumental only</span>
            <input
              type="checkbox"
              checked={instrumental}
              onChange={(e) => setInstrumental(e.target.checked)}
              className="h-4 w-4 rounded accent-indigo-600"
            />
          </label>
        </div>

        {!instrumental && (
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">What should the song be about?</label>
              <div className="flex gap-2">
                <input
                  value={lyricsTheme}
                  onChange={(e) => setLyricsTheme(e.target.value)}
                  placeholder="e.g., chasing dreams, a rainy night in Tokyo, falling out of love"
                  className="flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  onClick={handleGenerateLyrics}
                  disabled={generatingLyrics}
                  className="rounded-lg bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 px-4 py-2 text-sm font-medium hover:bg-indigo-100 dark:hover:bg-indigo-900/60 disabled:opacity-50 transition whitespace-nowrap"
                >
                  {generatingLyrics ? 'Writing...' : 'Write lyrics'}
                </button>
              </div>
            </div>

            <textarea
              value={lyrics}
              onChange={(e) => setLyrics(e.target.value)}
              rows={10}
              placeholder={`[Verse 1]\nYour verse here...\n\n[Chorus]\nYour chorus here...\n\nTip: Use [Verse], [Chorus], [Bridge], [Outro] tags for song structure`}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-mono text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
            {lyrics && (
              <p className="text-xs text-zinc-400">{lyrics.split('\n').filter(l => l.trim()).length} lines</p>
            )}
          </div>
        )}
      </section>

      {/* Step 3: Voice reference (optional) */}
      {!instrumental && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold">3</span>
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Voice reference</h2>
            <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-1">optional</span>
          </div>

          {!showVoiceRecorder ? (
            <button
              type="button"
              onClick={() => setShowVoiceRecorder(true)}
              className="w-full rounded-xl border-2 border-dashed border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 text-center hover:border-indigo-400 dark:hover:border-indigo-600 transition group"
            >
              <div className="text-3xl mb-2">🎤</div>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 group-hover:text-indigo-600 dark:group-hover:text-indigo-400">
                Sing or hum to set the vocal style
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                Record a sample — AI will match your voice and generate lyrics from what you sing
              </p>
            </button>
          ) : (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Sing or hum — AI will use your voice style and can generate lyrics from your singing
                </p>
                {voiceBlob && (
                  <button
                    onClick={() => { setVoiceBlob(null); setShowVoiceRecorder(false) }}
                    className="text-xs text-zinc-400 hover:text-red-500 transition"
                  >
                    Remove
                  </button>
                )}
              </div>
              <AudioRecorder onRecordingComplete={setVoiceBlob} />
              {voiceBlob && (
                <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                  Voice reference recorded — will be used for vocal style
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {/* Step 4: Generate */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold">
            {!instrumental ? '4' : '3'}
          </span>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Generate</h2>
        </div>

        {/* Genre selector */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Genre</label>
            {!genre && (
              <span className="text-xs text-zinc-400 dark:text-zinc-500">
                Auto-detected from your prompt
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {GENRES.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => handleGenreClick(g)}
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
          {genre === 'custom' && (
            <input
              value={customGenreText}
              onChange={(e) => setCustomGenreText(e.target.value)}
              placeholder="e.g., tropical house, afrobeats, bossa nova..."
              className="mt-2 w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              autoFocus
            />
          )}
        </div>

        {/* Fine-tune accordion */}
        <button
          type="button"
          onClick={() => setShowFineTune((v) => !v)}
          className="text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition flex items-center gap-1"
        >
          <span>{showFineTune ? 'Hide' : 'Fine-tune'} tempo & key</span>
          <span>{showFineTune ? '▲' : '▼'}</span>
        </button>

        {showFineTune && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Tempo {!tempoTouched && <span className="text-zinc-300 dark:text-zinc-600">(auto)</span>}
                </label>
                <span className="text-xs font-mono text-zinc-900 dark:text-white">{tempo} BPM</span>
              </div>
              <input
                type="range" min={60} max={200} value={tempo}
                onChange={(e) => { setTempo(Number(e.target.value)); setTempoTouched(true) }}
                className="w-full accent-indigo-600"
              />
              <div className="flex justify-between text-xs text-zinc-400 mt-0.5">
                <span>60</span>
                {tempoTouched && (
                  <button onClick={() => setTempoTouched(false)} className="text-indigo-500 hover:text-indigo-400">
                    Reset to auto
                  </button>
                )}
                <span>200</span>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                Key {!keyTouched && <span className="text-zinc-300 dark:text-zinc-600">(auto)</span>}
              </label>
              <select
                value={musicalKey}
                onChange={(e) => { setMusicalKey(e.target.value); setKeyTouched(true) }}
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              {keyTouched && (
                <button onClick={() => setKeyTouched(false)} className="text-xs text-indigo-500 hover:text-indigo-400 mt-1">
                  Reset to auto
                </button>
              )}
            </div>
          </div>
        )}

        {/* Generate button */}
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!canGenerate}
          className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-zinc-200 dark:disabled:bg-zinc-800 disabled:text-zinc-400 dark:disabled:text-zinc-600 disabled:cursor-not-allowed text-white font-semibold py-4 text-base transition-colors shadow-sm"
        >
          {isGenerating
            ? 'Generating...'
            : instrumental
              ? 'Generate Instrumental'
              : voiceBlob
                ? 'Generate Song with Your Voice'
                : lyrics.trim()
                  ? 'Generate Song with Vocals'
                  : 'Generate Song'
          }
        </button>
      </section>

      {/* Progress */}
      {isGenerating && jobStatus && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium text-zinc-900 dark:text-white animate-pulse">
              {STEPS.find((s) => s.key === jobStatus.status)?.label || 'Processing...'}
            </p>
            <button
              onClick={handleCancel}
              className="text-xs text-zinc-400 hover:text-red-500 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1 transition"
            >
              Cancel
            </button>
          </div>
          <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2">
            <div
              className="bg-indigo-600 h-2 rounded-full transition-all duration-700"
              style={{ width: `${jobStatus.progress || 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {!isGenerating && error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4">
          <p className="text-sm font-medium text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Results */}
      {result && <ResultPanel result={result} />}
    </div>
  )
}
