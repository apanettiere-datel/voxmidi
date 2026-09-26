import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { SparklesIcon, ArrowUpTrayIcon, MicrophoneIcon } from '@heroicons/react/20/solid'
import { Button } from '@/components/catalyst/button'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { wavBytes } from '@/lib/studio/files'
import { diatonicChords, ALL_KEYS } from '@/lib/studio/theory'
import { updateTrack, totalBars, makeTrack, BEATS_PER_BAR } from '@/lib/studio/project'
import { StepLabel, Pill, Callout, Wave, Toggle, panel, outlineBtn } from '@/components/voxmidi/studio/ui'

const FEELS = ['Half-time', 'Driving', 'Laid back', 'Sparse', 'Anthemic']
const GENRES = ['Indie rock', 'Folk', 'Lo-fi', 'R&B', 'Synthwave', 'Trap', 'House', 'Jazz']
const MAX_LOOP_BARS = 8   // a looped part repeats in whole passes of at most 8 bars
const MAX_VOCAL_BARS = 32

export const INSTRUMENTS = [
  { id: 'harmonic', label: 'Guitar or keys', noun: 'riff', loops: true, hint: 'Chords are read from what you play' },
  { id: 'bass', label: 'Bass', noun: 'bass line', loops: true, hint: 'Chords are built on the roots you play' },
  { id: 'drums', label: 'Drums', noun: 'beat', loops: true, hint: 'Tempo and groove come from your kick; you pick the key' },
  { id: 'vocals', label: 'Vocals', noun: 'vocal', loops: false, hint: 'Your melody is harmonized with chords under it' },
]

// Parts the AI can add; the one you played is left out
const PARTS = [
  { id: 'drums', label: 'Drums', not: 'drums' },
  { id: 'bass', label: 'Bass', not: 'bass' },
  { id: 'chords', label: 'Chords (guitar or keys)', not: 'harmonic' },
  { id: 'melody', label: 'Lead melody', not: 'vocals' },
]
const DEFAULT_PARTS = {
  harmonic: ['drums', 'bass'],
  bass: ['drums', 'chords'],
  drums: ['bass', 'chords'],
  vocals: ['drums', 'bass', 'chords'],
}
// Where the recording lands, and what it's called
const DEST = { harmonic: ['guitar', 'Guitar'], vocals: ['vocals', 'Vocals'], bass: [null, 'Bass (you)'], drums: [null, 'Drums (you)'] }

// Kick positions inside a bar from strum accents: a 16th counts when an
// accent lands on it in at least a third of the bars
function grooveFrom(analysis) {
  if (analysis.groove) return analysis.groove
  const bars = Math.max(1, analysis.bars)
  const counts = new Map()
  for (const a of analysis.accents) {
    if (a.beat < -0.125 || a.beat >= bars * 4) continue
    const pos = ((Math.round(a.beat * 4) / 4) % 4 + 4) % 4
    counts.set(pos, (counts.get(pos) || 0) + 1)
  }
  const out = [...counts].filter(([, n]) => n >= Math.max(1, bars / 3)).map(([p]) => p)
  if (!out.includes(0)) out.push(0)
  return out.sort((a, b) => a - b).slice(0, 8)
}

// Section layout in whole passes of the recording, so the chords restart
// exactly where it does
function structureFor(kind, n) {
  if (kind === 'vocals') {
    const intro = Math.min(4, n)
    return [{ kind: 'Intro', bars: intro }, { kind: 'Verse', bars: n }, { kind: 'Outro', bars: intro }]
  }
  const long = n <= 4 ? 2 * n : n
  return [
    { kind: 'Intro', bars: n }, { kind: 'Verse', bars: long }, { kind: 'Chorus', bars: long },
    { kind: 'Verse', bars: long }, { kind: 'Chorus', bars: long }, { kind: 'Outro', bars: n },
  ]
}

export default function RiffPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { takes, addTake, loadTake, analyzeRiff, compose, openProject, setProject, usage, toast } = useStudio()

  const [takeId, setTakeId] = useState(params.get('take'))
  const take = takes.find((t) => t.id === takeId)
  const [kind, setKind] = useState(params.get('kind') || 'harmonic')
  const [analysis, setAnalysis] = useState(null)
  const [busy, setBusy] = useState(null) // 'analyze' | 'build'
  const [error, setError] = useState(null)
  const [tempo, setTempo] = useState(null)
  const [key, setKey] = useState(null)
  const [chords, setChords] = useState([])
  const [autoChords, setAutoChords] = useState(false)
  const [feel, setFeel] = useState('Half-time')
  const [genre, setGenre] = useState('Indie rock')
  const [followGroove, setFollowGroove] = useState(true)
  const [parts, setParts] = useState(new Set(DEFAULT_PARTS.harmonic))

  const inst = INSTRUMENTS.find((i) => i.id === kind)
  const blocked = usage && usage.used >= usage.limit

  // The take remembers what was recorded
  useEffect(() => { if (take?.instrument) setKind(take.instrument) }, [take?.id])
  useEffect(() => { setParts(new Set(DEFAULT_PARTS[kind])); setFollowGroove(kind !== 'vocals') }, [kind])

  // Analyze whenever the take or the instrument changes
  useEffect(() => {
    if (!take) return
    let alive = true
    setBusy('analyze')
    setError(null)
    setAnalysis(null)
    const hints = { instrument: kind, ...(take.tempo ? { tempo: take.tempo, start: 0 } : {}) }
    loadTake(take.id)
      .then((buf) => {
        if (!buf) throw new Error("That take couldn't be loaded. Record or upload it again.")
        return analyzeRiff(new Blob([wavBytes(buf)], { type: 'audio/wav' }), hints)
      })
      .then((r) => {
        if (!alive) return
        // A take recorded to the click already knows its tempo, and starts on bar 1
        const clicked = take.tempo || null
        if (clicked && !r.tempo_options.includes(clicked)) r.tempo_options = [...r.tempo_options, clicked].sort((a, b) => a - b)
        setAnalysis({ ...r, clicked })
        setTempo(clicked || Math.round(r.tempo))
        setKey(r.key || 'A minor')
        const limit = kind === 'vocals' ? MAX_VOCAL_BARS : MAX_LOOP_BARS
        setChords(r.chords.slice(0, limit).map((c) => c.chord))
        setAutoChords(kind === 'drums')
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setBusy(null))
    return () => { alive = false }
  }, [take?.id, kind])

  async function takeFromBlob(blob, name) {
    setError(null)
    try {
      const buf = await engine.context().decodeAudioData(await blob.arrayBuffer())
      const meta = await addTake(buf, { name, instrument: kind })
      setTakeId(meta.id)
    } catch {
      setError("That file didn't decode as audio. Try a WAV, MP3 or a fresh recording.")
    }
  }

  function pickChord(i, name) {
    setChords((cs) => cs.map((c, k) => (k === i ? name : c)))
  }

  function togglePart(id) {
    setParts((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function build() {
    setBusy('build')
    setError(null)
    try {
      const gridTempo = analysis.clicked || analysis.tempo
      const start = analysis.clicked ? 0 : analysis.start
      const recBars = Math.max(1, analysis.clicked ? Math.floor(((take.duration - start) * gridTempo) / 60 / BEATS_PER_BAR) : analysis.bars)
      // Loops repeat in whole passes; a vocal plays once, as long as it is
      const n = inst.loops ? Math.min(recBars, MAX_LOOP_BARS) : Math.min(recBars, MAX_VOCAL_BARS)
      const useChords = autoChords ? null : chords.slice(0, n)
      const body = {
        prompt: `Built around your ${inst.noun}`,
        tempo, key, feel, genre,
        structure: structureFor(kind, inst.loops && autoChords ? Math.max(4, n) : n),
        ...(useChords && useChords.length ? { chords: useChords } : {}),
        ...(followGroove && groove ? { groove } : {}),
      }
      const data = await compose(body)
      let p = openProject(data)

      // Only the parts you asked for; the one you played stays yours
      for (const id of ['drums', 'bass', 'chords', 'melody']) {
        if (!parts.has(id)) p = updateTrack(p, id, { notes: [] })
      }

      // Place the recording: loops repeat one clip per pass (so a rounded
      // tempo can't drift more than one pass), a vocal plays once after the intro
      const passSec = (n * BEATS_PER_BAR * 60) / gridTempo
      const songBeats = totalBars(p.sections) * BEATS_PER_BAR
      const clips = []
      if (inst.loops) {
        const stride = Math.max(BEATS_PER_BAR, Math.round((passSec * data.tempo) / 60 / BEATS_PER_BAR) * BEATS_PER_BAR)
        for (let b = 0; b < songBeats; b += stride) {
          clips.push({ id: `c${b}-${Date.now().toString(36)}`, takeId: take.id, startBeat: b, offset: start, duration: Math.min(passSec, ((songBeats - b) * 60) / data.tempo) })
        }
      } else {
        const at = p.sections[0].bars * BEATS_PER_BAR
        clips.push({ id: `c${Date.now().toString(36)}`, takeId: take.id, startBeat: at, offset: start, duration: Math.min(take.duration - start, ((songBeats - at) * 60) / data.tempo) })
      }
      const [destId, destName] = DEST[kind]
      if (destId) {
        p = updateTrack(p, destId, { clips })
      } else {
        const t = { ...makeTrack(p, 'audio'), name: destName, clips }
        const at = p.tracks.findIndex((x) => x.id === (kind === 'drums' ? 'drums' : 'bass')) + 1
        p = { ...p, tracks: [...p.tracks.slice(0, at), t, ...p.tracks.slice(at)] }
      }
      setProject({ ...p, name: `Built around your ${inst.noun}` }, { undoable: false })
      toast(`Band built around your ${inst.noun}`)
      navigate('/song')
    } catch (e) {
      setError(e.status === 429 ? `That's your ${usage?.limit ?? ''} songs for the month. Your recording is saved as a take.` : e.message)
    } finally {
      setBusy(null)
    }
  }

  const groove = analysis ? grooveFrom(analysis) : null
  const facts = analysis && [
    { k: analysis.clicked ? `Tempo · recorded to a ${analysis.clicked} BPM click` : 'Tempo', v: `${tempo} BPM`, conf: analysis.tempo_confidence, alts: analysis.tempo_options.map((b) => ({ label: String(b), on: tempo === b, pick: () => setTempo(b) })) },
    kind === 'drums'
      ? { k: 'Key · drums have none, so pick one', v: key, select: true }
      : { k: 'Key', v: key, conf: analysis.key_confidence, alts: analysis.key_options.map((o) => ({ label: o, on: key === o, pick: () => setKey(o) })) },
  ]
  const optionsFor = (i) => {
    const detected = analysis.chords[i]?.options || []
    return [...new Set([...detected, ...diatonicChords(key)])].slice(0, 6)
  }
  const available = PARTS.filter((x) => x.not !== kind)
  const nothingToAdd = ![...parts].some((id) => available.some((x) => x.id === id))

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Start from your recording</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Play a riff, a bass line, a beat or sing. We listen for tempo, key and chords, then write the rest of the band around you. Your recording stays audio.
        </p>
      </div>

      {/* Step 1: what and the recording */}
      <section className={clsx(panel, 'p-5 space-y-3')}>
        <StepLabel n={1} title="What did you record?" hint={inst.hint} />
        <div className="flex flex-wrap gap-1.5">
          {INSTRUMENTS.map((i) => <Pill key={i.id} on={kind === i.id} onClick={() => setKind(i.id)}>{i.label}</Pill>)}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button color="red" onClick={() => navigate(`/record?new=1&kind=${kind}`)}>
            <MicrophoneIcon data-slot="icon" />
            Record it
          </Button>
          <label className={clsx(outlineBtn, 'inline-flex items-center gap-1.5 cursor-pointer py-1.5')}>
            <ArrowUpTrayIcon className="size-4" />
            Upload a file
            <input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; f && takeFromBlob(f, f.name.replace(/\.[^.]+$/, '')) }} />
          </label>
          {takes.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 ml-1">
              or use a take
              <select value={takeId || ''} onChange={(e) => setTakeId(e.target.value || null)} className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-1.5 py-1 text-xs text-zinc-900 dark:text-white">
                <option value="">Choose one</option>
                {[...takes].reverse().map((t) => <option key={t.id} value={t.id}>{t.name} · {t.duration.toFixed(1)}s</option>)}
              </select>
            </label>
          )}
        </div>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">Record it plays a click so the tempo and bar lines come out exact. Uploads work too: WAV, MP3 or M4A.</p>
      </section>

      {busy === 'analyze' && (
        <div className={clsx(panel, 'p-5')}>
          <p className="font-medium text-zinc-900 dark:text-white animate-pulse">Listening to your {inst.noun}...</p>
        </div>
      )}
      {error && <Callout title={error} />}

      {analysis && (
        <>
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-canvas px-4 py-3.5">
            <div className="flex items-baseline gap-2.5 mb-2.5">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{take?.name} · {analysis.bars} bars</span>
              <span className="ml-auto font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">{tempo} BPM · {key} · {analysis.bars} bars{analysis.notes ? ` · ${analysis.notes.length} notes` : ''}</span>
            </div>
            <div className="relative">
              <Wave peaks={analysis.peaks} height={70} />
              {analysis.accents.map((a, i) => (
                <div key={i} className="absolute top-0 bottom-0 w-0.5 bg-amber-500"
                  style={{ left: `${(a.time / analysis.duration) * 100}%`, opacity: 0.25 + (a.strength / 100) * 0.5 }} />
              ))}
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <span className="size-2 rounded-sm bg-amber-500" />
              <span className="text-xs text-zinc-400 dark:text-zinc-500">
                {kind === 'drums' ? 'Kicks and snares we heard' : kind === 'harmonic' ? 'Strum accents we heard' : 'Notes we heard'}
              </span>
            </div>
          </div>

          <div className="flex gap-3 flex-wrap">
            {facts.map((f) => (
              <div key={f.k} className={clsx(panel, 'flex-1 min-w-[14rem] px-4 py-3.5')}>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">{f.k}</span>
                  {f.conf != null && <span className="ml-auto font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">{f.conf}% sure</span>}
                </div>
                <div className="mt-0.5 font-mono tabular-nums text-lg font-medium text-zinc-900 dark:text-white">{f.v}</div>
                {f.select ? (
                  <select value={key} onChange={(e) => setKey(e.target.value)} className="mt-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 font-mono text-sm text-zinc-900 dark:text-white">
                    {ALL_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                ) : (
                  <div className="flex flex-wrap gap-1.5 mt-2.5">
                    {f.alts.map((a) => <Pill key={a.label} on={a.on} onClick={a.pick} className="font-mono text-xs px-2 py-0.5">{a.label}</Pill>)}
                  </div>
                )}
              </div>
            ))}
          </div>

          {kind !== 'drums' ? (
            <section className={clsx(panel, 'p-5')}>
              <StepLabel n={2} title="Check the chords" hint={kind === 'vocals' ? 'One per bar, under your melody. Tap another to change it' : 'One per bar. Tap another to change it'} />
              {inst.loops && analysis.bars > MAX_LOOP_BARS && (
                <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">Your {inst.noun} has {analysis.bars} bars. The first {MAX_LOOP_BARS} repeat through the song.</p>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3.5">
                {chords.map((c, i) => (
                  <div key={i} className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 p-2">
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
            </section>
          ) : (
            <section className={clsx(panel, 'p-5')}>
              <StepLabel n={2} title="Chords" hint="Your beat has no pitch" />
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">We'll write a progression in {key} that fits the style you pick. You can change any of it on the Song screen afterwards.</p>
            </section>
          )}

          <section className={clsx(panel, 'p-5 space-y-4')}>
            <StepLabel n={3} title="What should the AI add?" hint="Everything it writes is MIDI you can edit" />
            <div className="flex flex-wrap gap-1.5">
              {available.map((x) => <Pill key={x.id} on={parts.has(x.id)} onClick={() => togglePart(x.id)}>{x.label}</Pill>)}
            </div>
            <div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1.5">Style and feel</div>
              <div className="flex flex-wrap gap-1.5">
                {GENRES.map((g) => <Pill key={g} on={genre === g} onClick={() => setGenre(g)}>{g}</Pill>)}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {FEELS.map((f) => <Pill key={f} on={feel === f} onClick={() => setFeel(f)}>{f}</Pill>)}
              </div>
            </div>
            {kind !== 'vocals' && (
              <div className="flex items-center gap-3 flex-wrap">
                <Toggle on={followGroove} onChange={setFollowGroove} label="Follow my groove" />
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {kind === 'drums' ? 'Bass locks to your kick' : kind === 'bass' ? 'Kick locks to your bass notes' : 'Kick and bass follow your strum accents'}
                </span>
                <div className="flex gap-0.5" aria-label="Groove">
                  {Array.from({ length: 16 }, (_, i) => (
                    <span key={i} className={clsx('w-2.5 h-4 rounded-[2px]', groove.includes(i / 4) && followGroove ? 'bg-indigo-500' : i % 4 === 0 ? 'bg-zinc-700' : 'bg-zinc-800')} />
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <Button color="indigo" disabled={busy === 'build' || blocked || nothingToAdd} onClick={build}>
                <SparklesIcon data-slot="icon" />
                {busy === 'build' ? 'Building...' : 'Build the band'}
              </Button>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">
                {blocked ? `You've used all ${usage.limit} songs this month.` : nothingToAdd ? 'Pick at least one part to add.' : 'Counts as one song. Afterwards, make any part sound real on its editor screen.'}
              </span>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
