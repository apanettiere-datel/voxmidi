import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronLeftIcon, ChevronRightIcon, ArrowPathIcon } from '@heroicons/react/20/solid'
import EditorFrame from '@/components/voxmidi/studio/EditorFrame'
import { Toggle, outlineBtn, plainBtn, panel } from '@/components/voxmidi/studio/ui'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { DRUM_LANES, BEATS_PER_BAR, totalBars, sectionRanges, spliceNotes, updateTrack, trackById, barMap } from '@/lib/studio/project'

const STEPS = 16
const HIT = 0.12 // a note within this many beats of a step belongs to it

function findHit(notes, p, t) {
  return notes.findIndex((n) => n.p === p && Math.abs(n.t - t) < HIT)
}

function DrumEditor() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { project, setProject, regenerate, rewrite, toast } = useStudio()
  const drums = trackById(project, 'drums')
  const bars = totalBars(project.sections)
  const bar = Math.min(bars - 1, Math.max(0, parseInt(params.get('bar') || '0', 10) || 0))
  const o = bar * BEATS_PER_BAR
  const section = barMap(project.sections)[bar]?.sec
  const [playStep, setPlayStep] = useState(-1)
  const [busy, setBusy] = useState(null)
  const paint = useRef(null)

  const setBar = (b) => setParams({ bar: String(Math.max(0, Math.min(bars - 1, b))) }, { replace: true })
  const setNotes = (fn, what) => setProject((p) => updateTrack(p, 'drums', (t) => ({ notes: fn(t.notes) })), { what })

  // Light up the step under the playhead when it's in this bar
  useEffect(() => engine.subscribe((b) => {
    const s = b == null || b < o || b >= o + BEATS_PER_BAR ? -1 : Math.floor((b - o) * 4)
    setPlayStep((prev) => (prev === s ? prev : s))
  }), [o])

  // Drag-to-paint: the first cell decides whether the drag adds or erases
  useEffect(() => {
    const up = () => { paint.current = null }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  function applyCell(lane, step, add) {
    const t = o + step * 0.25
    setNotes((notes) => {
      const k = findHit(notes, lane.p, t)
      if (add && k < 0) return [...notes, { p: lane.p, t, d: 0.12, v: 100 }].sort((a, b) => a.t - b.t)
      if (!add && k >= 0) return notes.filter((_, i) => i !== k)
      return notes
    }, add ? 'Added a drum hit' : 'Removed a drum hit')
    if (add) engine.audition(drums, { p: lane.p, v: 100, d: 0.12 })
  }

  function cellDown(e, lane, step, on) {
    if (e.button !== 0) return
    e.preventDefault()
    paint.current = { add: !on }
    applyCell(lane, step, !on)
  }

  function cellEnter(lane, step, on) {
    if (!paint.current || paint.current.add === on) return
    applyCell(lane, step, paint.current.add)
  }

  function cycle(e, lane, step) {
    e.preventDefault()
    const t = o + step * 0.25
    setNotes((notes) => {
      const k = findHit(notes, lane.p, t)
      if (k < 0) return notes
      const n = notes[k]
      const next = n.roll ? { ...n, roll: false, flam: true } : n.flam ? { ...n, flam: false } : { ...n, roll: true }
      return notes.map((x, i) => (i === k ? next : x))
    }, 'Changed a hit to roll or flam')
  }

  function velDrag(e, step, v0) {
    e.preventDefault()
    const y0 = e.clientY
    const t = o + step * 0.25
    let first = true
    const move = (ev) => {
      const nv = Math.round(Math.max(8, Math.min(127, (v0 || 90) - ((ev.clientY - y0) / 44) * 127)))
      setProject((p) => updateTrack(p, 'drums', (tr) => ({ notes: tr.notes.map((n) => (Math.abs(n.t - t) < HIT ? { ...n, v: nv } : n)) })), { undoable: first, what: first ? 'Changed velocity' : undefined })
      first = false
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  async function regenBar() {
    setBusy('bar')
    try {
      await rewrite('drums', { start: o, end: o + BEATS_PER_BAR, what: `Rewrote drums in bar ${bar + 1}` })
      toast(`Bar ${bar + 1} rewritten`)
    } catch (err) {
      toast(err.message)
    } finally {
      setBusy(null)
    }
  }

  // Fills live in the last bar of each section: rewrite just those bars
  async function toggleFills(on) {
    setBusy('fill')
    try {
      const notes = await regenerate('drums', { seed: project.seed, fills: on })
      const lastBars = sectionRanges(project.sections).map((r) => [r.end - BEATS_PER_BAR, r.end])
      setProject((p) => {
        let out = trackById(p, 'drums').notes
        for (const [s, e] of lastBars) out = spliceNotes(out, s, e, notes.filter((n) => n.t >= s && n.t < e))
        return { ...updateTrack(p, 'drums', { notes: out }), fills: on }
      }, { what: on ? 'Turned section-end fills on' : 'Turned section-end fills off' })
      toast(on ? 'Fills added at each section end' : 'Fills removed')
    } catch (err) {
      toast(err.message)
    } finally {
      setBusy(null)
    }
  }

  const barNotes = drums.notes.filter((n) => n.t >= o - HIT && n.t < o + BEATS_PER_BAR - HIT)

  return (
    <div className="flex-1 overflow-auto px-5 py-4">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button type="button" onClick={() => navigate('/song')} className={plainBtn}>
          <ChevronLeftIcon className="size-4" />
          Song
        </button>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Drums</h2>
        <span className="font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">
          {drums.notes.length} hits · {drums.sound}{section ? ` · ${section.kind}` : ''}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setBar(bar - 1)} disabled={bar === 0} className={outlineBtn} aria-label="Previous bar"><ChevronLeftIcon className="size-4" /></button>
          <span className="font-mono tabular-nums text-sm text-zinc-900 dark:text-white min-w-[80px] text-center">Bar {bar + 1} / {bars}</span>
          <button type="button" onClick={() => setBar(bar + 1)} disabled={bar >= bars - 1} className={outlineBtn} aria-label="Next bar"><ChevronRightIcon className="size-4" /></button>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-canvas overflow-hidden select-none">
        <div className="flex gap-0.5 px-2.5 pt-2 pb-1.5 border-b border-zinc-200 dark:border-zinc-800">
          <div className="w-[104px] flex-none" />
          {Array.from({ length: STEPS }, (_, i) => (
            <div key={i} className={clsx('flex-1 min-w-0 text-center font-mono text-[10px]', i === playStep ? 'text-indigo-300' : i % 4 === 0 ? 'text-zinc-400' : 'text-zinc-600')}>
              {i % 4 === 0 ? i / 4 + 1 : '·'}
            </div>
          ))}
        </div>

        {DRUM_LANES.map((lane) => (
          <div key={lane.id} className="flex items-center gap-0.5 px-2.5 py-[3px]">
            <div className="w-[104px] flex-none flex items-center gap-1.5">
              <span className="size-[7px] rounded-sm" style={{ background: lane.color }} />
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{lane.label}</span>
            </div>
            {Array.from({ length: STEPS }, (_, step) => {
              const n = barNotes.find((x) => x.p === lane.p && Math.abs(x.t - (o + step * 0.25)) < HIT)
              const on = !!n
              return (
                <button
                  key={step}
                  type="button"
                  title={`${lane.label} step ${step + 1}`}
                  onPointerDown={(e) => cellDown(e, lane, step, on)}
                  onPointerEnter={() => cellEnter(lane, step, on)}
                  onContextMenu={(e) => cycle(e, lane, step)}
                  className={clsx('flex-1 min-w-0 h-6 pointer-coarse:h-11 rounded-[4px] border text-[10px] leading-none text-white touch-none', on ? 'border-transparent' : 'border-zinc-800', step === playStep && 'ring-1 ring-indigo-400')}
                  style={{
                    background: on ? lane.color : step % 4 === 0 ? 'var(--zinc-800)' : 'rgb(39 39 42 / .45)',
                    opacity: on ? 0.45 + (n.v / 127) * 0.55 : 1,
                  }}
                >
                  {n?.roll ? '⋮' : n?.flam ? '‹' : ''}
                </button>
              )
            })}
          </div>
        ))}

        <div className="flex items-end gap-0.5 px-2.5 py-2.5 border-t border-zinc-200 dark:border-zinc-800">
          <div className="w-[104px] flex-none text-xs text-zinc-400 dark:text-zinc-500">Velocity</div>
          {Array.from({ length: STEPS }, (_, step) => {
            const ns = barNotes.filter((x) => Math.abs(x.t - (o + step * 0.25)) < HIT)
            const v = ns.length ? Math.max(...ns.map((x) => x.v)) : 0
            return (
              <div
                key={step}
                onPointerDown={(e) => ns.length && velDrag(e, step, v)}
                title={ns.length ? `Velocity ${v}` : undefined}
                className={clsx('flex-1 min-w-0 h-11 flex items-end rounded-[4px] touch-none', ns.length && 'cursor-ns-resize', step % 4 === 0 && 'bg-white/[0.03]')}
              >
                <div className="w-full rounded-t-[2px]" style={{ height: `${Math.max(3, (v / 127) * 100)}%`, background: v ? 'var(--indigo-500)' : 'transparent' }} />
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex gap-4 mt-4 flex-wrap">
        <div className={clsx(panel, 'flex-1 min-w-[220px] p-4 flex flex-col gap-3.5')}>
          {[['Swing', 'swing'], ['Humanize', 'humanize']].map(([label, field]) => (
            <div key={field} className="flex items-center gap-3">
              <span className="w-16 text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
              <input
                type="range"
                min={0}
                max={60}
                value={project[field]}
                onChange={(e) => setProject((p) => ({ ...p, [field]: e.target.valueAsNumber }), { undoable: false })}
                className="flex-1 accent-indigo-500"
              />
              <span className="w-10 text-right font-mono tabular-nums text-xs text-zinc-700 dark:text-zinc-300">{project[field]}%</span>
            </div>
          ))}
          <div className="flex items-center gap-2.5">
            <Toggle on={project.fills} onChange={toggleFills} label="Section-end fills" />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {busy === 'fill' ? 'Rewriting section ends...' : 'Fill in the last bar of each section'}
            </span>
          </div>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">Swing and humanize apply to playback and to the exported MIDI.</p>
        </div>

        <div className={clsx(panel, 'flex-none w-[260px] p-4 flex flex-col gap-2.5')}>
          <div className="text-sm font-semibold text-zinc-900 dark:text-white">Not feeling this bar?</div>
          <p className="text-xs leading-4 text-zinc-400 dark:text-zinc-500">Rewrites one bar only. The rest of the pattern stays exactly as you left it.</p>
          <button type="button" onClick={regenBar} disabled={!!busy} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-3 py-1.5 text-sm font-semibold text-white">
            <ArrowPathIcon className={clsx('size-4', busy === 'bar' && 'animate-spin')} />
            Regenerate this bar
          </button>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">Free and unlimited.</span>
        </div>
      </div>
      <p className="mt-3.5 text-xs text-zinc-400 dark:text-zinc-500">
        Click a step to toggle it, or drag across steps to paint. Right-click a step to cycle it through roll and flam. Drag a velocity bar up or down.
      </p>
    </div>
  )
}

export default function StudioDrumsPage() {
  return (
    <EditorFrame>
      <DrumEditor />
    </EditorFrame>
  )
}
