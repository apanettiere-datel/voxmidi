import { useState, useEffect } from 'react'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import AudioRecorder from '@/components/voxmidi/AudioRecorder'
import { Button } from '@/components/catalyst/button'

export const JAM_PARTS = [
  { id: 'drums',  label: 'Drums',          sub: 'Tight room kit, brushed hats' },
  { id: 'bass',   label: 'Bass',           sub: 'Follows your root notes' },
  { id: 'guitar', label: 'Rhythm guitar',  sub: 'Strummed chords under your part' },
  { id: 'pads',   label: 'Pads',           sub: 'Warm analog sustain' },
  { id: 'synth',  label: 'Synth',          sub: 'Prompted 30s loop', texture: true },
  { id: 'fx',     label: 'FX / Noise',     sub: 'Risers, beds, one-shots', texture: true },
]

export const JAM_TEXTURE_PRESETS = {
  synth: [
    { id: 'techno', label: 'Dark Techno', prompt: 'dark techno synth loop, driving, analog saturation' },
    { id: 'acid',   label: 'Acid Line',   prompt: 'acid 303 synth line, resonant filter sweep' },
    { id: 'pad',    label: 'Atmos Pad',   prompt: 'atmospheric synth pad with subtle modulation' },
  ],
  fx: [
    { id: 'riser',  label: 'Horror Riser', prompt: 'eerie riser with tape hiss and detuned drone' },
    { id: 'tape',   label: 'Tape Noise',   prompt: 'warm tape noise bed, gentle wow and flutter' },
    { id: 'impact', label: 'Impact',       prompt: 'deep cinematic impact with long reverb tail' },
  ],
}

const JAM_FULL_BAND = ['drums', 'bass', 'guitar', 'pads']

const STATUS_LABELS = {
  queued:           'Waiting in queue...',
  processing:       'Starting...',
  generating_audio: 'Generating audio...',
  complete:         'Done!',
}

// ── Part card ──────────────────────────────────────────────────────────────────

function PartCard({ part, active, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`rounded-xl border p-3 text-left transition flex flex-col gap-1 ${
        active
          ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30 dark:border-indigo-600'
          : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-zinc-300 dark:hover:border-zinc-700'
      }`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-sm font-medium text-zinc-900 dark:text-white leading-snug">{part.label}</span>
        {part.texture && (
          <span className="shrink-0 text-[10px] font-medium rounded-full px-1.5 py-0.5 bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-400 border border-violet-200 dark:border-violet-800">
            loop
          </span>
        )}
      </div>
      <span className="text-xs text-zinc-500 dark:text-zinc-400 leading-snug">{part.sub}</span>
    </button>
  )
}

// ── Kind badge ─────────────────────────────────────────────────────────────────

const KIND_COLORS = {
  drums:  'bg-pink-100 dark:bg-pink-950/50 text-pink-700 dark:text-pink-400 border-pink-200 dark:border-pink-800',
  bass:   'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800',
  guitar: 'bg-lime-100 dark:bg-lime-950/50 text-lime-700 dark:text-lime-400 border-lime-200 dark:border-lime-800',
  pads:   'bg-cyan-100 dark:bg-cyan-950/50 text-cyan-700 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800',
  synth:  'bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-400 border-violet-200 dark:border-violet-800',
  fx:     'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700',
}

function KindBadge({ kind }) {
  const cls = KIND_COLORS[kind] || 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700'
  return (
    <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 border ${cls}`}>{kind}</span>
  )
}

// ── Captured pill ──────────────────────────────────────────────────────────────

function CapturedPill({ label }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center rounded-full bg-emerald-100 dark:bg-emerald-950/60 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        Captured
      </span>
      {label && <span className="text-xs text-zinc-400 dark:text-zinc-500">{label}</span>}
    </div>
  )
}

// ── Result view ────────────────────────────────────────────────────────────────

function JamResult({ result }) {
  const { tempo, key, duration, original, tracks = [], mix_url, midi_url } = result

  const metaLine = [
    tempo    ? `${tempo} BPM` : null,
    key      ? key            : null,
    duration ? `${duration}s` : null,
  ].filter(Boolean).join(' · ')

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-600 text-white text-xs font-bold">4</span>
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Result</h2>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-5">

        {/* Tempo / key / duration */}
        {metaLine && (
          <p className="font-mono text-sm text-zinc-600 dark:text-zinc-400">{metaLine}</p>
        )}

        {/* Full mix player */}
        {mix_url && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Full mix</p>
            <audio controls src={mix_url} className="w-full" />
          </div>
        )}

        {/* Original riff */}
        {original?.audio_url && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {original.label || 'Your riff'}
            </p>
            <audio controls src={original.audio_url} className="w-full" />
          </div>
        )}

        {/* Per-track list */}
        {/* TrackMixer expects MIDI note data (notes[], program) which /api/jam tracks don't carry.
            Rendering a simple per-track list with audio element + label + kind badge instead. */}
        {tracks.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Tracks
              <span className="ml-1.5 text-zinc-400 dark:text-zinc-600 font-normal">
                {tracks.length} stem{tracks.length !== 1 ? 's' : ''}
              </span>
            </p>
            {tracks.map((track) => (
              <div
                key={track.id}
                className="rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 p-3 space-y-2"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-zinc-900 dark:text-white flex-1 min-w-0 truncate">
                    {track.label}
                  </span>
                  {track.kind && <KindBadge kind={track.kind} />}
                  {track.midi_url && (
                    <a
                      href={track.midi_url}
                      download
                      className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline shrink-0"
                    >
                      MIDI
                    </a>
                  )}
                </div>
                {track.audio_url && (
                  <audio controls src={track.audio_url} className="w-full" />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Download row */}
        {(mix_url || midi_url) && (
          <div className="flex flex-wrap gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
            {mix_url && (
              <a
                href={mix_url}
                download
                className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition"
              >
                Download mix
              </a>
            )}
            {midi_url && (
              <a
                href={midi_url}
                download
                className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition"
              >
                Download MIDI
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function JamPage() {
  const authFetch = useAuthFetch()
  const { jobs, startJob, removeJob, cancelJob } = useJobs()

  // Recording
  const [riffBlob,    setRiffBlob]    = useState(null)
  const [beatboxBlob, setBeatboxBlob] = useState(null)
  const [showBeatbox, setShowBeatbox] = useState(false)

  // Parts
  const [parts, setParts] = useState(new Set(['drums', 'bass', 'guitar']))
  const [texturePrompts, setTexturePrompts] = useState({
    synth: JAM_TEXTURE_PRESETS.synth[0].prompt,
    fx:    JAM_TEXTURE_PRESETS.fx[0].prompt,
  })
  const [texturePresetIds, setTexturePresetIds] = useState({ synth: 'techno', fx: 'riser' })
  const [stylePrompt, setStylePrompt] = useState('')

  // Generation
  const [currentJobId, setCurrentJobId] = useState(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error,        setError]        = useState(null)
  const [result,       setResult]       = useState(null)

  // Watch job state — mirrors GeneratePage pattern exactly
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

  function togglePart(id) {
    setParts((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function selectFullBand() {
    setParts(new Set(JAM_FULL_BAND))
  }

  function selectTexturePreset(partId, preset) {
    setTexturePresetIds((p) => ({ ...p, [partId]: preset.id }))
    setTexturePrompts((p)   => ({ ...p, [partId]: preset.prompt }))
  }

  async function handleGenerate() {
    if (!riffBlob) return
    setError(null)
    setResult(null)
    setIsGenerating(true)

    try {
      const activeParts = [...parts]
      const formData = new FormData()
      formData.append('riff', riffBlob, 'riff.webm')
      if (beatboxBlob && showBeatbox) {
        formData.append('beatbox', beatboxBlob, 'beatbox.webm')
      }
      formData.append('parts', JSON.stringify(activeParts))
      if (stylePrompt.trim()) formData.append('style_prompt', stylePrompt.trim())
      // Texture selections travel in the single `preset` field the API declares,
      // as JSON: { synth: { preset, prompt }, fx: { preset, prompt } }
      const textures = {}
      for (const p of activeParts) {
        const meta = JAM_PARTS.find((x) => x.id === p)
        if (meta?.texture) {
          textures[p] = { preset: texturePresetIds[p] || '', prompt: texturePrompts[p] || '' }
        }
      }
      if (Object.keys(textures).length) formData.append('preset', JSON.stringify(textures))

      const res = await authFetch('/api/jam', { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `Request failed: ${res.status}`)
      }
      const jobData = await res.json()
      const jobId = jobData.job_id
      setCurrentJobId(jobId)

      startJob(jobId, {
        label: `Jam · ${activeParts.length} part${activeParts.length !== 1 ? 's' : ''}${stylePrompt ? ` · "${stylePrompt.slice(0, 30)}"` : ''}`,
      })
    } catch (err) {
      setError(err.message)
      setIsGenerating(false)
    }
  }

  async function handleCancel() {
    if (!currentJobId) return
    await cancelJob(currentJobId)
    setIsGenerating(false)
    setCurrentJobId(null)
    setError('Generation cancelled.')
  }

  const jobStatus = currentJob
    ? { status: currentJob.status, progress: currentJob.progress }
    : null

  const canGenerate = !isGenerating && !!riffBlob

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Jam</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Record a riff, pick the parts the AI should add, then mix
        </p>
      </div>

      {/* Step 1: Lay down your riff */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold">1</span>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Lay down your riff</h2>
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-3">
          {riffBlob && <CapturedPill label="Riff recorded and ready" />}
          <AudioRecorder onRecordingComplete={setRiffBlob} />
        </div>

        {/* Beatbox option — only meaningful when drums is selected */}
        {parts.has('drums') && (
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3">
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Beatbox it</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Record a beatbox take to guide the drum rhythm
                </p>
              </div>
              <input
                type="checkbox"
                checked={showBeatbox}
                onChange={(e) => setShowBeatbox(e.target.checked)}
                className="h-4 w-4 rounded accent-indigo-600 ml-4 shrink-0"
              />
            </label>
            {showBeatbox && (
              <div className="space-y-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
                {beatboxBlob && <CapturedPill label="Beatbox recorded" />}
                <AudioRecorder onRecordingComplete={setBeatboxBlob} />
              </div>
            )}
          </div>
        )}
      </section>

      {/* Step 2: Pick parts */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold">2</span>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Pick the parts to add</h2>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">AI fills in around you</span>
        </div>

        {/* Full band shortcut */}
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="flex-1 min-w-[14rem] text-sm text-zinc-500 dark:text-zinc-400">
            In a hurry? Drop in a full band and adjust after.
          </span>
          <button
            type="button"
            onClick={selectFullBand}
            className="rounded-lg bg-zinc-800 hover:bg-zinc-700 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-white px-3 py-1.5 text-sm font-medium transition"
          >
            Full band
          </button>
        </div>

        {/* Part cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {JAM_PARTS.map((p) => (
            <PartCard
              key={p.id}
              part={p}
              active={parts.has(p.id)}
              onToggle={() => togglePart(p.id)}
            />
          ))}
        </div>

        {/* Texture prompt panels for active texture parts */}
        {JAM_PARTS.filter((p) => p.texture && parts.has(p.id)).map((p) => (
          <div
            key={p.id}
            className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                {p.label} prompt
              </span>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">30s loop</span>
            </div>

            {/* Preset chips */}
            <div className="flex flex-wrap gap-1.5">
              {JAM_TEXTURE_PRESETS[p.id].map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => selectTexturePreset(p.id, preset)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    texturePresetIds[p.id] === preset.id
                      ? 'bg-indigo-600 text-white'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {/* Custom prompt */}
            <textarea
              value={texturePrompts[p.id]}
              onChange={(e) => setTexturePrompts((prev) => ({ ...prev, [p.id]: e.target.value }))}
              rows={2}
              placeholder={`Describe the ${p.label.toLowerCase()} sound...`}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
          </div>
        ))}

        {/* Style prompt */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Style prompt{' '}
            <span className="font-normal text-zinc-400 dark:text-zinc-600">optional</span>
          </label>
          <textarea
            value={stylePrompt}
            onChange={(e) => setStylePrompt(e.target.value)}
            rows={2}
            placeholder="e.g., dark synthwave, heavy reverb, 80s analog warmth"
            className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-3 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none shadow-sm"
          />
        </div>
      </section>

      {/* Step 3: Generate */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold">3</span>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Generate parts</h2>
        </div>

        {!riffBlob && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Record a riff above first.
          </p>
        )}

        <Button
          color="indigo"
          className="w-full justify-center py-4 text-base!"
          disabled={!canGenerate}
          onClick={handleGenerate}
        >
          {isGenerating
            ? 'Building the band...'
            : `Generate parts (${parts.size})`}
        </Button>
      </section>

      {/* Progress */}
      {isGenerating && jobStatus && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium text-zinc-900 dark:text-white animate-pulse">
              {STATUS_LABELS[jobStatus.status] || 'Processing...'}
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

      {/* Result */}
      {result && <JamResult result={result} />}
    </div>
  )
}
