import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { SparklesIcon, CheckIcon, ArrowUpTrayIcon } from '@heroicons/react/20/solid'
import { Button } from '@/components/catalyst/button'
import AudioRecorder from '@/components/voxmidi/AudioRecorder'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { wavBytes } from '@/lib/studio/files'
import { diatonicChords } from '@/lib/studio/theory'
import { updateTrack, totalBars, BEATS_PER_BAR } from '@/lib/studio/project'
import { StepLabel, Pill, Callout, Wave, panel } from '@/components/voxmidi/studio/ui'

const FEELS = ['Half-time', 'Driving', 'Laid back', 'Sparse', 'Anthemic']
const MAX_CHORDS = 8 // the compose endpoint takes a cycle of up to 8

export default function RiffPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { takes, addTake, analyzeRiff, compose, openProject, setProject, usage, toast } = useStudio()

  const [takeId, setTakeId] = useState(params.get('take'))
  const [analysis, setAnalysis] = useState(null)
  const [busy, setBusy] = useState(null) // 'analyze' | 'build'
  const [error, setError] = useState(null)
  const [tempo, setTempo] = useState(null)
  const [key, setKey] = useState(null)
  const [chords, setChords] = useState([])
  const [confirmed, setConfirmed] = useState(false)
  const [feel, setFeel] = useState('Half-time')

  const take = takes.find((t) => t.id === takeId)
  const blocked = usage && usage.used >= usage.limit

  // Analyze as soon as a take is chosen
  useEffect(() => {
    if (!take) return
    const buf = engine.takes.get(take.id)
    if (!buf) return
    let alive = true
    setBusy('analyze')
    setError(null)
    setAnalysis(null)
    setConfirmed(false)
    analyzeRiff(new Blob([wavBytes(buf)], { type: 'audio/wav' }))
      .then((r) => {
        if (!alive) return
        setAnalysis(r)
        setTempo(Math.round(r.tempo))
        setKey(r.key)
        setChords(r.chords.slice(0, MAX_CHORDS).map((c) => c.chord))
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setBusy(null))
    return () => { alive = false }
  }, [take?.id])

  async function takeFromBlob(blob, name) {
    setError(null)
    try {
      const ctx = engine.context()
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
      const meta = await addTake(buf, { name })
      setTakeId(meta.id)
    } catch {
      setError("That file didn't decode as audio. Try a WAV, MP3 or a fresh recording.")
    }
  }

  function pickChord(i, name) {
    setChords((cs) => cs.map((c, k) => (k === i ? name : c)))
    setConfirmed(false)
  }

  async function build() {
    setBusy('build')
    setError(null)
    try {
      const data = await compose({ prompt: `Built around ${take.name}`, tempo, key, chords, feel })
      let p = openProject(data)
      // Drums and bass only: the riff is the harmony
      p = updateTrack(p, 'chords', { notes: [] })
      p = updateTrack(p, 'melody', { notes: [] })
      // Loop the riff's whole bars across the song, one clip per pass, so a
      // rounded tempo can't drift more than one riff length
      const seconds = (analysis.bars * BEATS_PER_BAR * 60) / analysis.tempo
      const stride = Math.max(BEATS_PER_BAR, Math.round((seconds * data.tempo) / 60 / BEATS_PER_BAR) * BEATS_PER_BAR)
      const songBeats = totalBars(p.sections) * BEATS_PER_BAR
      const clips = []
      for (let b = 0; b < songBeats; b += stride) {
        clips.push({ id: `c${b}-${Date.now().toString(36)}`, takeId: take.id, startBeat: b, offset: analysis.start, duration: Math.min(seconds, ((songBeats - b) * 60) / data.tempo) })
      }
      p = updateTrack(p, 'guitar', { clips })
      setProject({ ...p, name: 'Built around your riff' }, { undoable: false })
      toast('Drums and bass built around your riff')
      navigate('/song')
    } catch (e) {
      setError(e.status === 429 ? `That's your ${usage?.limit ?? ''} songs for the month. Your riff is saved as a take.` : e.message)
    } finally {
      setBusy(null)
    }
  }

  const facts = analysis && [
    { k: 'Tempo', v: `${tempo} BPM`, conf: analysis.tempo_confidence, alts: analysis.tempo_options.map((b) => ({ label: String(b), on: tempo === b, pick: () => setTempo(b) })) },
    { k: 'Key', v: key, conf: analysis.key_confidence, alts: analysis.key_options.map((o) => ({ label: o, on: key === o, pick: () => { setKey(o); setConfirmed(false) } })) },
  ]
  const optionsFor = (i) => {
    const detected = analysis.chords[i]?.options || []
    return [...new Set([...detected, ...diatonicChords(key)])].slice(0, 6)
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Start from your own riff</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Here's what we heard. Detection gets chords wrong sometimes, so fix anything that's off before we build around it.
        </p>
      </div>

      {/* Step 1: the riff */}
      <section className={clsx(panel, 'p-5 space-y-3')}>
        <StepLabel n={1} title="Your riff" hint="Play at least one full bar, ideally four" />
        {takes.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            Use a take
            <select value={takeId || ''} onChange={(e) => setTakeId(e.target.value || null)} className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-1.5 py-1 text-xs text-zinc-900 dark:text-white">
              <option value="">Choose one</option>
              {takes.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.duration.toFixed(1)}s</option>)}
            </select>
          </label>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-start">
          <AudioRecorder label="Record your riff" onRecordingComplete={(blob) => takeFromBlob(blob, 'Riff')} />
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer">
            <ArrowUpTrayIcon className="size-4" />
            Upload audio
            <input type="file" accept="audio/*" className="hidden" onChange={(e) => e.target.files[0] && takeFromBlob(e.target.files[0], e.target.files[0].name.replace(/\.[^.]+$/, ''))} />
          </label>
        </div>
      </section>

      {busy === 'analyze' && (
        <div className={clsx(panel, 'p-5')}>
          <p className="font-medium text-zinc-900 dark:text-white animate-pulse">Listening for tempo, key and chords...</p>
        </div>
      )}
      {error && <Callout title={error} />}

      {analysis && (
        <>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-canvas px-4 py-3.5">
            <div className="flex items-baseline gap-2.5 mb-2.5">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{take?.name} · {analysis.bars} bars</span>
              <span className="ml-auto font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">{tempo} BPM · {key} · {analysis.bars} bars</span>
            </div>
            <div className="relative">
              <Wave peaks={analysis.peaks} height={70} />
              {analysis.accents.map((a, i) => (
                <div key={i} title={`Accent at beat ${a.beat}`} className="absolute top-0 bottom-0 w-0.5 bg-amber-500"
                  style={{ left: `${(a.time / analysis.duration) * 100}%`, opacity: 0.4 + (a.strength / 100) * 0.5 }} />
              ))}
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <span className="size-2 rounded-sm bg-amber-500" />
              <span className="text-xs text-zinc-400 dark:text-zinc-500">Strum accents we detected. These set the groove</span>
            </div>
          </div>

          <div className="flex gap-3 flex-wrap">
            {facts.map((f) => (
              <div key={f.k} className={clsx(panel, 'flex-1 min-w-[14rem] px-4 py-3.5')}>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">{f.k}</span>
                  <span className="ml-auto font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">{f.conf}% sure</span>
                </div>
                <div className="mt-0.5 font-mono tabular-nums text-lg font-medium text-zinc-900 dark:text-white">{f.v}</div>
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {f.alts.map((a) => <Pill key={a.label} on={a.on} onClick={a.pick} className="font-mono text-xs px-2 py-0.5">{a.label}</Pill>)}
                </div>
              </div>
            ))}
          </div>

          <section className={clsx(panel, 'p-5')}>
            <StepLabel n={2} title="Confirm chords" hint="One per bar. Tap to change" />
            {analysis.bars > MAX_CHORDS && (
              <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">Your riff has {analysis.bars} bars. The first {MAX_CHORDS} set the progression.</p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3.5">
              {chords.map((c, i) => (
                <div key={i} className={clsx('rounded-lg border bg-zinc-50 dark:bg-zinc-950/60 p-2', confirmed ? 'border-emerald-800' : 'border-zinc-200 dark:border-zinc-800')}>
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">Bar {i + 1}</span>
                    <span className="font-mono tabular-nums text-[10px] text-zinc-500">{analysis.chords[i]?.confidence}%</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {optionsFor(i).map((o) => (
                      <button key={o} type="button" onClick={() => pickChord(i, o)}
                        className={clsx('rounded px-1.5 py-0.5 font-mono text-xs border', c === o ? 'bg-indigo-600 border-transparent text-white' : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400')}>
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-4">
              <Button color="indigo" onClick={() => { setConfirmed(true); toast('Chords confirmed') }}>
                <CheckIcon data-slot="icon" />
                Confirm chords
              </Button>
              <span className={clsx('text-xs', confirmed ? 'text-emerald-400' : 'text-zinc-400 dark:text-zinc-500')}>
                {confirmed ? 'Confirmed. You can build now' : 'Building needs confirmed chords'}
              </span>
            </div>
          </section>

          <section className={clsx(panel, 'p-5 transition-opacity', !confirmed && 'opacity-50')}>
            <div className="mb-3"><StepLabel n={3} title="Pick a feel" /></div>
            <div className="flex flex-wrap gap-1.5">
              {FEELS.map((f) => <Pill key={f} on={feel === f} onClick={() => setFeel(f)}>{f}</Pill>)}
            </div>
            <div className="flex items-center gap-3 mt-4 flex-wrap">
              <Button color="indigo" disabled={!confirmed || busy === 'build' || blocked} onClick={build}>
                <SparklesIcon data-slot="icon" />
                {busy === 'build' ? 'Building...' : 'Build Drums & Bass Around This'}
              </Button>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">
                {blocked ? `You've used all ${usage.limit} songs this month.` : 'Counts as one song. Your riff goes on the Guitar track.'}
              </span>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
