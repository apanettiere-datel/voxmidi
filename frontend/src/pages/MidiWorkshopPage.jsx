import { useState, useRef } from 'react'
import { transcribeAudio, downloadMidiClientSide, workshopGenerate, workshopReference, enhancePrompt, getSettings } from '@/lib/api'
import { useAuthFetch } from '@/lib/authFetch'
import AudioRecorder from '@/components/voxmidi/AudioRecorder'
import PianoPanel from '@/components/voxmidi/PianoPanel'

const GENRES = [
  { id: 'pop', label: 'Pop' },
  { id: 'rock', label: 'Rock' },
  { id: 'edm', label: 'EDM' },
  { id: 'lo-fi-hip-hop', label: 'Lo-fi' },
  { id: 'trap', label: 'Trap' },
  { id: 'house', label: 'House' },
  { id: 'jazz', label: 'Jazz' },
  { id: 'synthwave', label: 'Synthwave' },
  { id: 'ambient', label: 'Ambient' },
]

const KEYS = ['C', 'Cm', 'C#', 'C#m', 'D', 'Dm', 'Eb', 'Ebm', 'E', 'Em', 'F', 'Fm', 'F#', 'F#m', 'G', 'Gm', 'Ab', 'Abm', 'A', 'Am', 'Bb', 'Bbm', 'B', 'Bm']

function ToolCard({ title, subtitle, icon, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 min-w-[120px] rounded-xl border p-4 text-left transition ${
        active
          ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30 ring-1 ring-indigo-500'
          : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:border-indigo-300 dark:hover:border-indigo-700'
      }`}
    >
      <span className="text-2xl">{icon}</span>
      <p className={`text-sm font-semibold mt-2 ${active ? 'text-indigo-700 dark:text-indigo-300' : 'text-zinc-800 dark:text-zinc-200'}`}>
        {title}
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{subtitle}</p>
    </button>
  )
}

function MidiResult({ result, label }) {
  if (!result) return null
  return (
    <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 p-5 space-y-3">
      <div>
        <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">{label || 'MIDI ready'}</p>
        <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">
          {result.tracks?.length || 0} track(s)
          {result.duration ? ` · ${Math.round(result.duration)}s` : ''}
          {result.tempo ? ` · ${Math.round(result.tempo)} BPM` : ''}
        </p>
      </div>

      {/* Track breakdown */}
      {result.tracks?.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {result.tracks.map((t, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-lg bg-white dark:bg-zinc-800 border border-emerald-200 dark:border-emerald-700 px-2.5 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-300"
            >
              {t.is_drum ? '🥁' : '🎵'} {t.name}
              <span className="text-zinc-400 dark:text-zinc-500">({t.notes} notes)</span>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {result.midi_url && (
          <a
            href={result.midi_url}
            download="voxmidi-workshop.mid"
            className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 text-sm font-semibold transition shadow-sm"
          >
            Download MIDI
          </a>
        )}
      </div>

      <p className="text-xs text-zinc-400">
        Import into FL Studio, Ableton, GarageBand, Logic, or any DAW. Each track is a separate instrument.
      </p>
    </div>
  )
}

export default function MidiWorkshopPage() {
  const authFetch = useAuthFetch()
  const [activeTool, setActiveTool] = useState('generate')

  // AI Generate state
  const [genPrompt, setGenPrompt] = useState('')
  const [genGenre, setGenGenre] = useState('')
  const [enhancedPrompt, setEnhancedPrompt] = useState('')
  const [enhancing, setEnhancing] = useState(false)
  const [useEnhanced, setUseEnhanced] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genResult, setGenResult] = useState(null)
  const [genError, setGenError] = useState(null)

  // Reference state
  const [refFile, setRefFile] = useState(null)
  const [refPreviewUrl, setRefPreviewUrl] = useState(null)
  const [converting, setConverting] = useState(false)
  const [refResult, setRefResult] = useState(null)
  const [refError, setRefError] = useState(null)
  const refFileRef = useRef(null)

  // Hum + Accompany state
  const [humBlob, setHumBlob] = useState(null)
  const [humPrompt, setHumPrompt] = useState('')
  const [humGenre, setHumGenre] = useState('')
  const [humGenerating, setHumGenerating] = useState(false)
  const [humResult, setHumResult] = useState(null)
  const [humError, setHumError] = useState(null)

  // Hum to MIDI (simple transcription) state
  const [transcribeBlob, setTranscribeBlob] = useState(null)
  const [transcribing, setTranscribing] = useState(false)
  const [transcribeResult, setTranscribeResult] = useState(null)
  const [transcribeError, setTranscribeError] = useState(null)

  // Piano/chord state
  const [chordProgression, setChordProgression] = useState([])
  const [melodyBlob, setMelodyBlob] = useState(null)
  const [exportTempo, setExportTempo] = useState(120)

  // ─── AI Generate ─────────────────────────────────────────────────────────

  async function handleEnhanceGen() {
    if (!genPrompt.trim()) return
    setEnhancing(true)
    setGenError(null)
    try {
      const data = await enhancePrompt(genPrompt, genGenre, authFetch)
      setEnhancedPrompt(data.enhanced_prompt)
      setUseEnhanced(true)
    } catch (err) {
      setGenError(err.message)
    } finally {
      setEnhancing(false)
    }
  }

  async function handleGenerate() {
    const prompt = useEnhanced && enhancedPrompt ? enhancedPrompt : genPrompt
    if (!prompt.trim()) return
    setGenerating(true)
    setGenError(null)
    setGenResult(null)
    try {
      const settings = getSettings()
      const data = await workshopGenerate(prompt, genGenre, null, authFetch, parseInt(settings.midiResolution) || 480)
      setGenResult(data)
    } catch (err) {
      setGenError(err.message)
    } finally {
      setGenerating(false)
    }
  }

  // ─── Reference ───────────────────────────────────────────────────────────

  function handleRefFile(f) {
    setRefFile(f)
    if (refPreviewUrl) URL.revokeObjectURL(refPreviewUrl)
    setRefPreviewUrl(f ? URL.createObjectURL(f) : null)
    setRefResult(null)
    setRefError(null)
  }

  async function handleConvertReference() {
    if (!refFile) return
    setConverting(true)
    setRefError(null)
    setRefResult(null)
    try {
      const data = await workshopReference(refFile, authFetch)
      setRefResult(data)
    } catch (err) {
      setRefError(err.message)
    } finally {
      setConverting(false)
    }
  }

  // ─── Hum + Accompany ────────────────────────────────────────────────────

  async function handleHumAccompany() {
    if (!humBlob) return
    setHumGenerating(true)
    setHumError(null)
    setHumResult(null)
    try {
      const settings = getSettings()
      const data = await workshopGenerate(
        humPrompt || 'Generate accompaniment for this melody',
        humGenre,
        humBlob,
        authFetch,
        parseInt(settings.midiResolution) || 480,
      )
      setHumResult(data)
    } catch (err) {
      setHumError(err.message)
    } finally {
      setHumGenerating(false)
    }
  }

  // ─── Simple Hum to MIDI ─────────────────────────────────────────────────

  async function handleTranscribe() {
    if (!transcribeBlob) return
    setTranscribing(true)
    setTranscribeError(null)
    setTranscribeResult(null)
    try {
      const data = await transcribeAudio(transcribeBlob, authFetch)
      setTranscribeResult(data)
    } catch (err) {
      setTranscribeError(err.message)
    } finally {
      setTranscribing(false)
    }
  }

  // ─── Chord export ───────────────────────────────────────────────────────

  function handleExportChordMidi() {
    if (!chordProgression.length) return
    const CHORD_MIDI = {
      'C': [60,64,67], 'Cm': [60,63,67], 'D': [62,66,69], 'Dm': [62,65,69],
      'E': [64,68,71], 'Em': [64,67,71], 'F': [65,69,72], 'Fm': [65,68,72],
      'G': [67,71,74], 'Gm': [67,70,74], 'A': [69,73,76], 'Am': [69,72,76],
      'B': [71,75,78], 'Bm': [71,74,78], 'Cmaj7': [60,64,67,71],
      'Dm7': [62,65,69,72], 'G7': [67,71,74,77], 'Am7': [69,72,76,79],
      'Fmaj7': [65,69,72,76], 'Em7': [64,67,71,74], 'Bbmaj7': [70,74,77,81],
    }
    const beatDuration = 60 / exportTempo
    const chordDuration = beatDuration * 4
    const tracks = []
    const chordNotes = []
    chordProgression.forEach((chord, i) => {
      const midiNotes = CHORD_MIDI[chord] || [60,64,67]
      const start = i * chordDuration
      midiNotes.forEach((pitch) => {
        chordNotes.push({ pitch, start, end: start + chordDuration * 0.9, velocity: 80 })
      })
    })
    tracks.push({ name: 'Chords', channel: 0, program: 0, notes: chordNotes })
    const bassNotes = []
    chordProgression.forEach((chord, i) => {
      const root = CHORD_MIDI[chord]?.[0]
      if (root == null) return
      const start = i * chordDuration
      bassNotes.push({ pitch: root - 12, start, end: start + chordDuration * 0.8, velocity: 90 })
    })
    tracks.push({ name: 'Bass', channel: 1, program: 33, notes: bassNotes })
    downloadMidiClientSide(tracks, exportTempo, 'chord-progression.mid')
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">MIDI Workshop</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Create production-ready MIDI files for your DAW
        </p>
      </div>

      {/* Tool selector */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <ToolCard title="AI Generate" subtitle="Describe → MIDI" icon="🤖" active={activeTool === 'generate'} onClick={() => setActiveTool('generate')} />
        <ToolCard title="Reference" subtitle="Song → MIDI" icon="🎧" active={activeTool === 'reference'} onClick={() => setActiveTool('reference')} />
        <ToolCard title="Hum + Accompany" subtitle="Voice → full MIDI" icon="🎤" active={activeTool === 'accompany'} onClick={() => setActiveTool('accompany')} />
        <ToolCard title="Piano / Chords" subtitle="Play → export" icon="🎹" active={activeTool === 'piano'} onClick={() => setActiveTool('piano')} />
      </div>

      {/* ─── AI Generate ─────────────────────────────────────────────────── */}
      {activeTool === 'generate' && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Describe the MIDI you want</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              AI analyzes your description and generates multi-track MIDI with drums, bass, melody, and chords
            </p>
          </div>

          <textarea
            value={genPrompt}
            onChange={(e) => { setGenPrompt(e.target.value); if (useEnhanced) setUseEnhanced(false) }}
            rows={3}
            placeholder="e.g., Dark trap beat 140bpm, aggressive 808s, haunting melody, sparse hi-hats with rolls"
            className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-3 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
          />

          <div className="flex items-center gap-3">
            <button
              onClick={handleEnhanceGen}
              disabled={enhancing || !genPrompt.trim()}
              className="rounded-lg bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 px-4 py-2 text-xs font-medium hover:bg-indigo-100 dark:hover:bg-indigo-900/60 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {enhancing ? 'Enhancing...' : 'Enhance with AI'}
            </button>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              AI adds musical detail to your description
            </span>
          </div>

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
                rows={3}
                className={`w-full rounded-xl border px-4 py-3 text-xs text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none transition ${
                  useEnhanced
                    ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50/50 dark:bg-indigo-950/20'
                    : 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 opacity-60'
                }`}
              />
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Genre</label>
              {!genGenre && <span className="text-xs text-zinc-400 dark:text-zinc-500">Auto from prompt</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {GENRES.map((g) => (
                <button key={g.id} type="button" onClick={() => setGenGenre(genGenre === g.id ? '' : g.id)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    genGenre === g.id ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                  }`}>
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleGenerate}
            disabled={generating || !genPrompt.trim()}
            className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-zinc-200 dark:disabled:bg-zinc-800 disabled:text-zinc-400 disabled:cursor-not-allowed text-white font-semibold py-3 text-sm transition"
          >
            {generating ? 'Generating MIDI...' : 'Generate MIDI'}
          </button>

          {generating && (
            <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-4 text-center">
              <p className="text-sm text-zinc-600 dark:text-zinc-400 animate-pulse">
                AI is composing your MIDI tracks... this may take 15-30 seconds
              </p>
            </div>
          )}

          {genError && (
            <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3">
              <p className="text-sm text-red-700 dark:text-red-400">{genError}</p>
            </div>
          )}

          <MidiResult result={genResult} label="AI-Generated MIDI" />
        </div>
      )}

      {/* ─── Reference → MIDI ────────────────────────────────────────────── */}
      {activeTool === 'reference' && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Convert a song to MIDI</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Upload any track — we'll separate it into stems and transcribe each to MIDI. Get drums, bass, melody, and chords as editable MIDI tracks.
            </p>
          </div>

          <div
            onClick={() => refFileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleRefFile(f) }}
            className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
              refFile
                ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/20'
                : 'border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
            }`}
          >
            {refFile ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">{refFile.name}</p>
                <p className="text-xs text-zinc-400">{(refFile.size / 1048576).toFixed(1)} MB</p>
                <button type="button" onClick={(e) => { e.stopPropagation(); handleRefFile(null) }}
                  className="text-xs text-zinc-400 hover:text-red-500 underline">Remove</button>
              </div>
            ) : (
              <>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">Drop a song here or click to browse</p>
                <p className="text-xs text-zinc-400 mt-1">MP3, WAV, FLAC, OGG, M4A</p>
              </>
            )}
          </div>
          <input ref={refFileRef} type="file" accept="audio/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleRefFile(f) }} />

          {refPreviewUrl && (
            <audio controls src={refPreviewUrl} className="w-full h-9 rounded-lg" />
          )}

          {refFile && (
            <button
              onClick={handleConvertReference}
              disabled={converting}
              className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-zinc-200 dark:disabled:bg-zinc-800 disabled:text-zinc-400 disabled:cursor-not-allowed text-white font-semibold py-3 text-sm transition"
            >
              {converting ? 'Converting... (this takes ~60s)' : 'Convert to MIDI'}
            </button>
          )}

          {converting && (
            <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-4 space-y-2">
              <p className="text-sm text-zinc-600 dark:text-zinc-400 animate-pulse">
                Separating stems and transcribing to MIDI...
              </p>
              <div className="text-xs text-zinc-400 space-y-0.5">
                <p>1. Splitting into vocals, bass, drums, other</p>
                <p>2. Transcribing each stem to MIDI notes</p>
                <p>3. Combining into multi-track MIDI file</p>
              </div>
            </div>
          )}

          {refError && (
            <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3">
              <p className="text-sm text-red-700 dark:text-red-400">{refError}</p>
            </div>
          )}

          <MidiResult result={refResult} label="Reference → MIDI" />
        </div>
      )}

      {/* ─── Hum + Accompany ─────────────────────────────────────────────── */}
      {activeTool === 'accompany' && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Hum a melody, get a full arrangement</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Record your melody idea. AI will generate drums, bass, and chords that fit around it.
            </p>
          </div>

          <AudioRecorder onRecordingComplete={(blob) => { setHumBlob(blob); setHumResult(null); setHumError(null) }} />

          {humBlob && (
            <div className="space-y-3">
              <textarea
                value={humPrompt}
                onChange={(e) => setHumPrompt(e.target.value)}
                rows={2}
                placeholder="Optional: describe the style you want (e.g., jazzy piano trio, heavy metal, chill lo-fi)"
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              />

              <div className="flex flex-wrap gap-1.5">
                {GENRES.map((g) => (
                  <button key={g.id} type="button" onClick={() => setHumGenre(humGenre === g.id ? '' : g.id)}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
                      humGenre === g.id ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                    }`}>
                    {g.label}
                  </button>
                ))}
              </div>

              <button
                onClick={handleHumAccompany}
                disabled={humGenerating}
                className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-zinc-200 dark:disabled:bg-zinc-800 disabled:text-zinc-400 disabled:cursor-not-allowed text-white font-semibold py-3 text-sm transition"
              >
                {humGenerating ? 'Generating accompaniment...' : 'Generate Full Arrangement'}
              </button>
            </div>
          )}

          {humGenerating && (
            <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-4 text-center">
              <p className="text-sm text-zinc-600 dark:text-zinc-400 animate-pulse">
                Transcribing your melody and generating accompaniment...
              </p>
            </div>
          )}

          {humError && (
            <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3">
              <p className="text-sm text-red-700 dark:text-red-400">{humError}</p>
            </div>
          )}

          <MidiResult result={humResult} label="Your Melody + AI Accompaniment" />
        </div>
      )}

      {/* ─── Piano / Chords ──────────────────────────────────────────────── */}
      {activeTool === 'piano' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
            <PianoPanel
              onChordProgressionChange={setChordProgression}
              onMelodyBlobChange={setMelodyBlob}
            />
          </div>

          {chordProgression.length > 0 && (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-3">
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Export Chord MIDI</h3>
              <div className="flex items-center gap-3">
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Tempo</label>
                <input type="range" min={60} max={200} value={exportTempo}
                  onChange={(e) => setExportTempo(Number(e.target.value))} className="flex-1 accent-indigo-600" />
                <span className="text-xs font-mono text-zinc-900 dark:text-white w-14 text-right">{exportTempo} BPM</span>
              </div>
              <button onClick={handleExportChordMidi}
                className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 text-sm transition">
                Download Chord MIDI
              </button>
              <p className="text-xs text-zinc-400">Exports chords + bass as a multi-track MIDI file</p>
            </div>
          )}
        </div>
      )}

      {/* Tips */}
      <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 px-4 py-3 space-y-1">
        <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">For producers</p>
        <ul className="text-xs text-zinc-500 dark:text-zinc-400 space-y-0.5 list-disc list-inside">
          <li>All MIDI files use General MIDI instrument assignments — reassign sounds in your DAW</li>
          <li>Each track is on a separate MIDI channel for easy editing</li>
          <li>Works with FL Studio, Ableton, Logic, GarageBand, Cubase, and any standard DAW</li>
        </ul>
      </div>
    </div>
  )
}
