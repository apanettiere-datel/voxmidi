import { useState, useRef, useEffect } from 'react'

import { generateMidi, extractSource, transformStyle, saveToLibrary } from '@/lib/api'
import AudioRecorder from '@/components/voxmidi/AudioRecorder'
import SourceInput from '@/components/voxmidi/SourceInput'
import ResultPanel from '@/components/voxmidi/ResultPanel'
import { Button } from '@/components/catalyst/button'
import { Textarea } from '@/components/catalyst/textarea'
import { Select } from '@/components/catalyst/select'
import { Field, Label } from '@/components/catalyst/fieldset'
import { Switch, SwitchField } from '@/components/catalyst/switch'
import { Heading } from '@/components/catalyst/heading'
import { Text } from '@/components/catalyst/text'

const GENRES = [
  { id: 'edm', label: 'EDM' },
  { id: 'lo-fi-hip-hop', label: 'Lo-fi Hip Hop' },
  { id: 'trap', label: 'Trap' },
  { id: 'house', label: 'House' },
  { id: 'drum-and-bass', label: 'Drum & Bass' },
  { id: 'synthwave', label: 'Synthwave' },
  { id: 'pop', label: 'Pop' },
  { id: 'rock', label: 'Rock' },
  { id: 'jazz', label: 'Jazz' },
  { id: 'ambient', label: 'Ambient' },
  { id: 'r-and-b', label: 'R&B' },
  { id: 'classical', label: 'Classical' },
]

const KEYS = ['C', 'Cm', 'C#', 'C#m', 'D', 'Dm', 'Eb', 'Ebm', 'E', 'Em', 'F', 'Fm', 'F#', 'F#m', 'G', 'Gm', 'Ab', 'Abm', 'A', 'Am', 'Bb', 'Bbm', 'B', 'Bm']

export default function CreatePage() {
  const [audioBlob, setAudioBlob] = useState(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [prompt, setPrompt] = useState('')
  const [genre, setGenre] = useState('edm')
  const [tempo, setTempo] = useState(128)
  const [musicalKey, setMusicalKey] = useState('Am')
  const [trackToggles, setTrackToggles] = useState({ melody: true, bass: true, chords: true, drums: true })
  const [isProcessing, setIsProcessing] = useState(false)
  const [processingStep, setProcessingStep] = useState('')
  const [result, setResult] = useState(null)
  const [sourceResult, setSourceResult] = useState(null)
  const [transformPrompt, setTransformPrompt] = useState('')
  const [error, setError] = useState(null)
  const tapTimesRef = useRef([])

  // Load URL passed from Sources page via sessionStorage
  useEffect(() => {
    const url = sessionStorage.getItem('voxmidi_load_source')
    if (url) {
      setSourceUrl(url)
      sessionStorage.removeItem('voxmidi_load_source')
    }
  }, [])

  const canGenerate = !!audioBlob || (sourceUrl && !sourceUrl.startsWith('file://')) || prompt.trim().length > 0 || sourceUrl.startsWith('file://')

  function handleTapTempo() {
    const now = Date.now()
    tapTimesRef.current = [...tapTimesRef.current.filter(t => now - t < 3000), now]
    if (tapTimesRef.current.length >= 2) {
      const intervals = tapTimesRef.current.slice(1).map((t, i) => t - tapTimesRef.current[i])
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length
      const bpm = Math.round(60000 / avgInterval)
      setTempo(Math.min(200, Math.max(60, bpm)))
    }
  }

  function getGenerateLabel() {
    const hasVoice = !!audioBlob
    const hasSource = !!sourceUrl
    const hasPrompt = prompt.trim().length > 0
    if (hasVoice && hasSource && hasPrompt) return 'Generate MIDI from voice + source + prompt'
    if (hasVoice && hasPrompt) return 'Generate MIDI from voice + prompt'
    if (hasSource && hasPrompt) return 'Generate MIDI from source + prompt'
    if (hasVoice && hasSource) return 'Generate MIDI from voice + source'
    if (hasVoice) return 'Generate MIDI from voice'
    if (hasSource) return 'Generate MIDI from source'
    if (hasPrompt) return 'Generate MIDI from prompt'
    return 'Generate MIDI'
  }

  async function handleGenerate() {
    setIsProcessing(true)
    setError(null)
    setResult(null)
    setSourceResult(null)

    try {
      // Source URL mode
      if (sourceUrl && !sourceUrl.startsWith('file://')) {
        setProcessingStep('Extracting stems')
        const data = await extractSource(sourceUrl, null, null, genre, tempo, musicalKey)
        setSourceResult(data)
        setResult({
          job_id: data.job_id,
          midi_url: null,
          tracks: data.tracks || [],
          tempo: data.tempo || tempo,
          key: data.key || musicalKey,
          genre,
        })
        saveToLibrary({ ...data, genre }, { genre, tempo, key: musicalKey })
        return
      }

      // Voice / text / file mode
      setProcessingStep(audioBlob ? 'Transcribing audio' : 'Generating MIDI')
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

      const data = await generateMidi(formData)
      setResult(data)
      saveToLibrary(data, { genre, tempo, key: musicalKey })
    } catch (err) {
      setError(err.message)
    } finally {
      setIsProcessing(false)
      setProcessingStep('')
    }
  }

  async function handleTransform() {
    if (!sourceResult) return
    setIsProcessing(true)
    setError(null)
    try {
      setProcessingStep('Transforming style')
      const stemNames = Object.keys(sourceResult.stems || {})
      const data = await transformStyle(
        sourceResult.job_id,
        `${genre.replace(/-/g, ' ')} style at ${tempo} BPM in ${musicalKey}${transformPrompt ? ', ' + transformPrompt : ''}`,
        ['vocals'],
        stemNames.filter(n => n !== 'vocals'),
        tempo,
        musicalKey,
      )
      setResult(data)
      saveToLibrary(data, { genre, tempo, key: musicalKey })
    } catch (err) {
      setError(err.message)
    } finally {
      setIsProcessing(false)
      setProcessingStep('')
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <Heading>Create</Heading>
      <Text>Turn your voice, an audio source, or a text prompt into editable MIDI.</Text>

      {/* Input Area — two columns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Voice Recorder */}
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-4">🎤 Hum a melody, beatbox, or whistle</p>
          <AudioRecorder onRecordingComplete={setAudioBlob} />
        </div>

        {/* Right: Source Input */}
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-4">🔗 Or paste a YouTube URL / upload audio</p>
          <SourceInput url={sourceUrl} onUrlChange={setSourceUrl} />
        </div>
      </div>

      {/* Style Controls */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-6">
        {/* Genre chips */}
        <div>
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 block">Genre</label>
          <div className="flex flex-wrap gap-2">
            {GENRES.map(g => (
              <button key={g.id} onClick={() => setGenre(g.id)}
                className={`rounded-full px-3 py-1 text-sm font-medium transition ${genre === g.id ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'}`}>
                {g.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tempo + Key row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {/* Tempo */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Tempo</label>
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-zinc-900 dark:text-white w-12 text-right">{tempo} BPM</span>
                <button onClick={handleTapTempo} className="text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition">TAP</button>
              </div>
            </div>
            <input type="range" min={60} max={200} value={tempo} onChange={e => setTempo(Number(e.target.value))}
              className="w-full accent-indigo-600" />
            <div className="flex justify-between text-xs text-zinc-400 mt-1"><span>60</span><span>200</span></div>
          </div>

          {/* Key */}
          <Field>
            <Label>Key</Label>
            <Select value={musicalKey} onChange={e => setMusicalKey(e.target.value)}>
              {KEYS.map(k => <option key={k} value={k}>{k}</option>)}
            </Select>
          </Field>
        </div>

        {/* Track toggles */}
        <div>
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 block">Generate tracks</label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Object.entries(trackToggles).map(([name, enabled]) => (
              <SwitchField key={name}>
                <Label className="capitalize">{name}</Label>
                <Switch checked={enabled} onChange={v => setTrackToggles(t => ({...t, [name]: v}))} color="indigo" />
              </SwitchField>
            ))}
          </div>
        </div>

        {/* Prompt */}
        <Field>
          <Label>Style prompt</Label>
          <Textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={3}
            placeholder="Describe the vibe... e.g., euphoric EDM drop with arpeggiated synths and sidechain bass"
          />
        </Field>
      </div>

      {/* Generate Button */}
      <Button color="indigo" className="w-full" onClick={handleGenerate} disabled={!canGenerate || isProcessing}>
        {isProcessing ? `${processingStep || 'Processing'}...` : getGenerateLabel()}
      </Button>

      {/* Error */}
      {error && <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-4 text-sm text-red-700 dark:text-red-400">{error}</div>}

      {/* Results */}
      {result && <ResultPanel result={result} onSaveToLibrary={() => saveToLibrary(result, {genre, tempo: result.tempo || tempo, key: result.key || musicalKey})} />}

      {/* Source transform panel - appears after source extraction */}
      {sourceResult && !result && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-4">
          <h3 className="font-semibold text-zinc-900 dark:text-white">Transform extracted stems</h3>
          <Field>
            <Label>Style prompt for transformation</Label>
            <Textarea rows={2} value={transformPrompt} onChange={e => setTransformPrompt(e.target.value)}
              placeholder="e.g., lo-fi hip hop with jazzy chords..." />
          </Field>
          <Button color="indigo" onClick={handleTransform} disabled={isProcessing}>
            {isProcessing ? 'Transforming...' : 'Transform Style'}
          </Button>
        </div>
      )}
    </div>
  )
}
