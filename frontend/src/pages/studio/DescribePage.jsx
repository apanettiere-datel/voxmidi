import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { SparklesIcon, MicrophoneIcon, Squares2X2Icon, ChevronRightIcon, ChevronDownIcon } from '@heroicons/react/20/solid'
import { Button } from '@/components/catalyst/button'
import { useStudio } from '@/lib/studio/StudioContext'
import { ALL_KEYS } from '@/lib/studio/theory'
import { SECTION_COLORS, TRACK_COLORS } from '@/lib/studio/project'
import { StepLabel, Pill, Callout, ToolCard, panel } from '@/components/voxmidi/studio/ui'

const GENRES = ['Lo-fi', 'Trap', 'Indie rock', 'Synthwave', 'R&B', 'Drill', 'House', 'Folk', 'Ambient', 'Jazz']
const FEELS = ['Half-time', 'Driving', 'Laid back', 'Sparse', 'Anthemic', 'Hypnotic']
const GEN_TRACKS = ['drums', 'bass', 'chords', 'melody']
const GEN_NAMES = { drums: 'Drums', bass: '808 / Bass', chords: 'Chords', melody: 'Melody' }

// ── Generating view ────────────────────────────────────────────────────────────

function Generating({ result, error, onRetry, onOpen, onBack }) {
  const done = !!result
  const skeleton = 'animate-pulse text-zinc-300 dark:text-zinc-600'
  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">{done ? 'Your song is ready' : 'Writing your song'}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          You're getting a song you can edit, not an audio file. Every part below lands as MIDI you can open and change.
        </p>
      </div>
      <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2">
        <div className="bg-indigo-600 h-2 rounded-full transition-all duration-700" style={{ width: done ? '100%' : error ? '0%' : '45%' }} />
      </div>

      <div className={clsx(panel, 'p-5 space-y-4')}>
        <div className="flex items-center gap-5">
          {[['Tempo', done && `${result.tempo} BPM`], ['Key', done && result.key], ['Time', done && result.time_signature]].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5">
              <span className="text-xs text-zinc-400 dark:text-zinc-500">{k}</span>
              <span className={clsx('font-mono tabular-nums text-lg', v ? 'text-zinc-900 dark:text-white' : skeleton)}>{v || '...'}</span>
            </div>
          ))}
        </div>

        <div className="flex gap-1">
          {(done ? result.sections : Array.from({ length: 6 }, (_, i) => ({ id: i, bars: 1 }))).map((s) => (
            <div
              key={s.id}
              className={clsx('min-w-0 flex flex-col gap-0.5 rounded-md px-2 py-2', !done && 'animate-pulse bg-zinc-200 dark:bg-zinc-800')}
              style={{ flex: s.bars, background: done ? `color-mix(in srgb, ${SECTION_COLORS[s.kind]} 60%, transparent)` : undefined }}
            >
              <span className="text-xs font-semibold text-zinc-900 dark:text-white truncate">{done ? s.kind : ' '}</span>
              <span className="font-mono tabular-nums text-xs text-zinc-500 dark:text-zinc-300">{done ? s.bars : ' '}</span>
            </div>
          ))}
        </div>

        <div className="space-y-1.5">
          {GEN_TRACKS.map((id) => {
            const tr = result?.tracks.find((t) => t.id === id)
            return (
              <div key={id} className={clsx('flex items-center gap-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-950/60 px-2.5 py-2', !done && 'animate-pulse')}>
                <span className="size-2 shrink-0 rounded-sm" style={{ background: done ? TRACK_COLORS[id] : 'var(--zinc-700)' }} />
                <span className="text-sm text-zinc-700 dark:text-zinc-300 min-w-[88px]">{GEN_NAMES[id]}</span>
                <span className="flex-1 h-1.5 rounded-full" style={{ background: done ? `color-mix(in srgb, ${TRACK_COLORS[id]} 60%, transparent)` : 'var(--zinc-800)' }} />
                <span className="font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">{tr ? `${tr.notes.length} notes` : 'writing...'}</span>
              </div>
            )
          })}
        </div>
      </div>

      {error && (
        <Callout
          title="Couldn't write the song"
          actions={<>
            <Button color="indigo" onClick={onRetry}>Try again</Button>
            <Button outline onClick={onBack}>Change the description</Button>
          </>}
        >
          {error} Nothing was counted against your songs.
        </Callout>
      )}

      {done && (
        <div className="flex items-center gap-3">
          <Button color="indigo" onClick={onOpen}>Open the song</Button>
          <span className="font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">
            {result.sections.reduce((a, s) => a + s.bars, 0)} bars · {result.genre}{result.feel ? ` · ${result.feel}` : ''}
          </span>
        </div>
      )}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function DescribePage() {
  const navigate = useNavigate()
  const { project, usage, compose, openProject, refreshUsage, toast } = useStudio()

  const [prompt, setPrompt] = useState('')
  const [genre, setGenre] = useState(null)
  const [feel, setFeel] = useState(null)
  const [fineOpen, setFineOpen] = useState(false)
  const [tempo, setTempo] = useState(null)   // null = read it from the description
  const [key, setKey] = useState(null)

  const [phase, setPhase] = useState('form') // 'form' | 'generating'
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [limitHit, setLimitHit] = useState(false)

  const blocked = limitHit || (usage && usage.used >= usage.limit)

  useEffect(() => {
    if (!result) return
    const t = setTimeout(() => {
      openProject(result)
      toast('Song ready')
      navigate('/song')
    }, 900)
    return () => clearTimeout(t)
  }, [result])

  async function handleGenerate() {
    setError(null)
    setResult(null)
    setPhase('generating')
    const started = Date.now()
    try {
      const body = { prompt: prompt.trim() }
      if (genre) body.genre = genre
      if (feel) body.feel = feel
      if (tempo) body.tempo = tempo
      if (key) body.key = key
      const data = await compose(body)
      // Keep the writing state on screen long enough to read
      await new Promise((r) => setTimeout(r, Math.max(0, 700 - (Date.now() - started))))
      setResult(data)
    } catch (err) {
      if (err.status === 429) {
        setLimitHit(true)
        refreshUsage()
        setPhase('form')
      } else {
        setError(err.message)
      }
    }
  }

  if (phase === 'generating') {
    return (
      <Generating
        result={result}
        error={error}
        onRetry={handleGenerate}
        onOpen={() => { openProject(result); navigate('/song') }}
        onBack={() => { setPhase('form'); setError(null) }}
      />
    )
  }

  const fineSummary = [tempo ? `${tempo} BPM` : 'Auto tempo', key || 'auto key', '4/4'].join(' · ')

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-7">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Describe your song</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          You get a whole song back: drums, bass, chords and melody laid out in sections. Every part is MIDI you can edit or ask to change.
        </p>
      </div>

      {/* Step 1: Description */}
      <section className="space-y-3">
        <StepLabel n={1} title="Your description" />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="e.g., late night drive, sad piano, hard drums, around 90 BPM"
          className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-3 text-base text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none shadow-sm"
        />
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Tempo, key, genre and feel are read from what you write. Anything you pick below wins.
        </p>
      </section>

      {/* Step 2: Genre */}
      <section className="space-y-2.5">
        <StepLabel n={2} title="Genre" hint="Optional. Otherwise it's read from your description" />
        <div className="flex flex-wrap gap-1.5">
          {GENRES.map((g) => <Pill key={g} on={genre === g} onClick={() => setGenre(genre === g ? null : g)}>{g}</Pill>)}
        </div>
      </section>

      {/* Step 3: Feel */}
      <section className="space-y-2.5">
        <StepLabel n={3} title="Feel" hint="Optional" />
        <div className="flex flex-wrap gap-1.5">
          {FEELS.map((f) => <Pill key={f} on={feel === f} onClick={() => setFeel(feel === f ? null : f)}>{f}</Pill>)}
        </div>
      </section>

      {/* Fine-tune */}
      <div className={clsx(panel, 'overflow-hidden')}>
        <button
          type="button"
          onClick={() => setFineOpen(!fineOpen)}
          className="w-full flex items-center gap-2 px-4 py-3.5 text-left text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-white/[0.03] transition"
        >
          {fineOpen ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
          <span className="font-medium">Fine-tune tempo &amp; key</span>
          <span className="ml-auto font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">{fineSummary}</span>
        </button>
        {fineOpen && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 px-4 pb-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-zinc-500 dark:text-zinc-400">Tempo</label>
              <div className="flex items-center gap-2.5">
                <input
                  type="range"
                  min={60}
                  max={180}
                  value={tempo ?? 100}
                  onChange={(e) => setTempo(e.target.valueAsNumber)}
                  className="flex-1 accent-indigo-500"
                />
                <span className="font-mono tabular-nums text-sm text-zinc-900 dark:text-white min-w-[58px] text-right">{tempo ? `${tempo} BPM` : 'Auto'}</span>
              </div>
              {tempo && <button type="button" onClick={() => setTempo(null)} className="self-start text-xs text-zinc-400 hover:text-zinc-200">Back to auto</button>}
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-zinc-500 dark:text-zinc-400">Key</label>
              <select
                value={key ?? ''}
                onChange={(e) => setKey(e.target.value || null)}
                className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Auto</option>
                {ALL_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-zinc-500 dark:text-zinc-400">Time signature</label>
              <span className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-500 dark:text-zinc-400">4/4</span>
            </div>
          </div>
        )}
      </div>

      {/* Limit reached */}
      {blocked && usage && (
        <Callout
          tone="warning"
          title={`That's your ${usage.limit} songs for the month`}
          actions={project && <Button outline onClick={() => navigate('/song')}>Back to your song</Button>}
        >
          Everything you've already made is still here, still editable, and still exports. Regenerating parts inside a song stays free.
        </Callout>
      )}

      {/* Generate */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button color="indigo" disabled={blocked} onClick={handleGenerate}>
          <SparklesIcon data-slot="icon" />
          Generate Song
        </Button>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">Takes a second or two · counts as one song · regenerating parts afterwards is free</span>
      </div>

      <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

      {/* Other starting points */}
      <section>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Or start from something you play</h2>
        <p className="mt-1 mb-3.5 text-xs text-zinc-400 dark:text-zinc-500">Your recording stays audio. VoxMIDI writes the parts around it.</p>
        <div className="flex flex-wrap gap-2.5">
          <ToolCard icon={SparklesIcon} title="Describe it" sub="Text to a full arrangement" active />
          <ToolCard icon={MicrophoneIcon} title="Play or sing" sub="Guitar, keys, bass, drums or vocals" onClick={() => navigate('/riff')} />
          <ToolCard icon={Squares2X2Icon} title="Tap a groove" sub="Tap pads or beatbox it" onClick={() => navigate('/tap')} />
        </div>
      </section>
    </div>
  )
}
