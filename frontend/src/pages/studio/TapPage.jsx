import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Button } from '@/components/catalyst/button'
import AudioRecorder from '@/components/voxmidi/AudioRecorder'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { wavBytes } from '@/lib/studio/files'
import { useAuthFetch } from '@/lib/authFetch'
import { blankProject, updateTrack, totalBars, sectionRanges, BEATS_PER_BAR } from '@/lib/studio/project'
import { Callout, panel } from '@/components/voxmidi/studio/ui'

const PADS = [
  { name: 'Kick', key: 'K', p: 36, v: 118, band: 'low, under 150 Hz', color: 'var(--track-1)' },
  { name: 'Snare', key: 'S', p: 38, v: 104, band: 'mids', color: 'var(--track-2)' },
  { name: 'Hat', key: 'H', p: 42, v: 64, band: 'high, over 4 kHz', color: 'var(--track-6)' },
]
const LANE_PITCH = { kick: 36, snare: 38, hat: 42 }
const DRUMS = { id: 'drums', kind: 'midi', sound: 'Tight kit', vol: 90 }

// Quantize hits to 16ths, dropping duplicates on the same step
function snap(hits, loopBeats) {
  const seen = new Set()
  const out = []
  for (const h of hits) {
    const t = (Math.round(h.t * 4) / 4) % loopBeats
    const id = `${h.p}@${t}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ p: h.p, t, d: 0.12, v: h.v })
  }
  return out.sort((a, b) => a.t - b.t)
}

// Keep every hit and add ghost snares, 8th hats where there are gaps, and an open hat
function elaborate(base, loopBeats) {
  const out = [...base]
  const has = (p, t) => out.some((n) => n.p === p && Math.abs(n.t - t) < 0.1)
  for (let t = 0; t < loopBeats; t += 0.5) if (!has(42, t)) out.push({ p: 42, t, d: 0.08, v: t % 1 ? 34 : 48 })
  for (let bar = 0; bar < loopBeats / 4; bar++) {
    const g = bar * 4 + 1.75
    if (!has(38, g)) out.push({ p: 38, t: g, d: 0.1, v: 30 })
  }
  const open = loopBeats - 0.5
  const k = out.findIndex((n) => n.p === 42 && Math.abs(n.t - open) < 0.1)
  if (k >= 0) out.splice(k, 1)
  out.push({ p: 46, t: open, d: 0.25, v: 70 })
  return out.sort((a, b) => a.t - b.t)
}

export default function TapPage() {
  const navigate = useNavigate()
  const authFetch = useAuthFetch()
  const { project, setProject, toast } = useStudio()
  const [tempo, setTempo] = useState(project?.tempo ?? 96)
  const [loopBars, setLoopBars] = useState(2)
  const [hits, setHits] = useState([])
  const [running, setRunning] = useState(false)
  const [flash, setFlash] = useState(null)
  const [beatbox, setBeatbox] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const clock = useRef(null) // { start, timer }

  const bpm = project?.tempo ?? tempo
  const loopBeats = loopBars * BEATS_PER_BAR

  function startClick() {
    if (clock.current) return clock.current.start
    const ctx = engine.context()
    const spb = 60 / bpm
    const start = ctx.currentTime + 0.05
    let next = start
    let beat = 0
    const timer = setInterval(() => {
      while (next < ctx.currentTime + 0.3) { engine.click(next, beat % 4 === 0); next += spb; beat++ }
    }, 40)
    clock.current = { start, timer }
    setRunning(true)
    return start
  }

  function stopClick() {
    clearInterval(clock.current?.timer)
    clock.current = null
    setRunning(false)
  }

  useEffect(() => stopClick, [])

  function tap(pad) {
    const ctx = engine.context()
    const start = startClick()
    const t = Math.max(0, (ctx.currentTime - start) / (60 / bpm)) % loopBeats
    engine.audition(DRUMS, { p: pad.p, v: pad.v, d: 0.2 })
    setHits((h) => [...h, { p: pad.p, t, v: pad.v }])
    setFlash(pad.p)
    setTimeout(() => setFlash((f) => (f === pad.p ? null : f)), 90)
  }

  useEffect(() => {
    function onKey(e) {
      const tag = e.target?.tagName
      if (e.repeat || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey) return
      const pad = PADS.find((p) => p.key === e.key.toUpperCase())
      if (pad) { e.preventDefault(); tap(pad) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function analyzeBeatbox() {
    if (!beatbox) return
    setBusy(true)
    setError(null)
    try {
      const buf = await engine.context().decodeAudioData(await beatbox.arrayBuffer())
      const form = new FormData()
      form.append('beatbox', new Blob([wavBytes(buf)], { type: 'audio/wav' }), 'beatbox.wav')
      const res = await authFetch('/api/drums/analyze', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `Analysis failed: ${res.status}`)
      }
      const data = await res.json()
      const out = []
      for (const [lane, steps] of Object.entries(data.lanes || {})) {
        const pad = PADS.find((p) => p.p === LANE_PITCH[lane])
        for (const s of steps) out.push({ p: pad.p, t: s / data.steps_per_beat, v: pad.v })
      }
      if (!out.length) throw new Error("Didn't catch any hits. Beatbox a little louder and closer to the mic.")
      setLoopBars(Math.min(4, Math.max(1, data.bars)))
      if (!project) setTempo(Math.round(data.tempo))
      setHits(out)
      toast(`${out.length} hits from your beatbox`)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  function commit(extra) {
    if (!hits.length) { toast('Nothing captured yet'); return }
    stopClick()
    const base = snap(hits, loopBeats)
    const pattern = extra ? elaborate(base, loopBeats) : base
    const p0 = project || blankProject({ tempo: bpm, bars: 8, name: 'Tapped groove' })
    const bars = totalBars(p0.sections)
    const notes = []
    for (let o = 0; o < bars * BEATS_PER_BAR; o += loopBeats) for (const n of pattern) if (o + n.t < bars * BEATS_PER_BAR) notes.push({ ...n, t: o + n.t })
    // Elaborate also puts a fill at each section end
    if (extra) {
      for (const r of sectionRanges(p0.sections)) {
        const f = r.end - 1
        for (let i = notes.length - 1; i >= 0; i--) if (notes[i].t >= f && notes[i].t < r.end && notes[i].p !== 36) notes.splice(i, 1)
        ;[0, 0.25, 0.5, 0.75].forEach((x, k) => notes.push({ p: 38, t: f + x, d: 0.1, v: 72 + k * 12 }))
      }
      notes.sort((a, b) => a.t - b.t)
    }
    const next = updateTrack(p0, 'drums', { notes })
    setProject(next, { undoable: !!project, what: extra ? 'Tapped and elaborated the drums' : 'Tapped the drums' })
    toast(`${base.length} hits snapped to 16ths${extra ? `, ${pattern.length - base.length} added` : ''}`)
    navigate('/song')
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-5">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Tap a groove</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Tap the pads or use <span className="font-mono text-zinc-700 dark:text-zinc-300">K</span> / <span className="font-mono text-zinc-700 dark:text-zinc-300">S</span> / <span className="font-mono text-zinc-700 dark:text-zinc-300">H</span> while the click runs. Hits get snapped to the nearest 16th.
        </p>
      </div>

      <div className="flex items-center gap-5 flex-wrap text-xs text-zinc-500 dark:text-zinc-400">
        <label className="flex items-center gap-1.5">
          Tempo
          {project ? (
            <span className="font-mono tabular-nums text-sm text-zinc-700 dark:text-zinc-300">{bpm} BPM</span>
          ) : (
            <>
              <input type="number" min={40} max={240} value={tempo} disabled={running}
                onChange={(e) => { const v = e.target.valueAsNumber; if (v >= 40 && v <= 240) setTempo(v) }}
                className="w-16 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-center font-mono tabular-nums text-sm text-zinc-900 dark:text-white disabled:opacity-50" />
              BPM
            </>
          )}
        </label>
        <label className="flex items-center gap-1.5">
          Loop
          <select value={loopBars} disabled={running} onChange={(e) => setLoopBars(Number(e.target.value))}
            className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 font-mono text-sm text-zinc-900 dark:text-white disabled:opacity-50">
            {[1, 2, 4].map((b) => <option key={b} value={b}>{b} bar{b > 1 ? 's' : ''}</option>)}
          </select>
        </label>
        {running && <button type="button" onClick={stopClick} className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800">Stop the click</button>}
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        {PADS.map((pad) => (
          <button
            key={pad.p}
            type="button"
            onPointerDown={(e) => { e.preventDefault(); tap(pad) }}
            className={clsx(panel, 'flex flex-col items-center gap-1 py-6 px-2 transition active:scale-95 touch-none', flash === pad.p && 'border-indigo-500 bg-indigo-500/10')}
          >
            <span className="text-base font-semibold text-zinc-900 dark:text-white">{pad.name}</span>
            <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">{pad.key} · {pad.band}</span>
          </button>
        ))}
      </div>

      <div className="relative h-[92px] rounded-xl border border-zinc-200 dark:border-zinc-800 bg-canvas px-3 py-2.5 overflow-hidden">
        <span className="text-xs text-zinc-400 dark:text-zinc-500">Captured onsets: <span className="font-mono tabular-nums">{hits.length}</span></span>
        {Array.from({ length: loopBars }, (_, b) => (
          <div key={b} className="absolute top-8 bottom-2 w-px bg-zinc-800" style={{ left: `${3 + (b / loopBars) * 94}%` }} />
        ))}
        {hits.map((h, i) => {
          const pad = PADS.find((p) => p.p === h.p)
          return (
            <div key={i} className="absolute bottom-3 w-0.5" style={{ left: `${3 + (h.t / loopBeats) * 94}%`, height: h.p === 36 ? 40 : h.p === 38 ? 28 : 16, background: pad.color }} />
          )
        })}
      </div>

      <div className="flex gap-2 flex-wrap">
        <Button color="indigo" className="flex-1 justify-center" onClick={() => commit(false)}>Snap to the grid</Button>
        <Button outline onClick={() => commit(true)}>Elaborate pattern</Button>
        <Button outline onClick={() => { setHits([]); stopClick() }}>Clear</Button>
      </div>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Both repeat your loop across the {project ? 'whole song, replacing its drum part' : 'new song'}. Elaborate keeps every hit where you put it and fills in 8th hats, ghost snares, an open hat and a fill at each section end.
      </p>

      <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

      <section className={clsx(panel, 'p-5 space-y-3')}>
        <div>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Or beatbox it</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            Record a beatbox take. Each hit is sorted into kick, snare or hat by how much low and high energy it has.
          </p>
        </div>
        <AudioRecorder label="Record your beatbox" onRecordingComplete={setBeatbox} />
        {error && <Callout title={error} />}
        <Button color="dark/zinc" className="w-full justify-center" disabled={!beatbox || busy} onClick={analyzeBeatbox}>
          {busy ? 'Analyzing...' : 'Turn it into hits'}
        </Button>
      </section>
    </div>
  )
}
