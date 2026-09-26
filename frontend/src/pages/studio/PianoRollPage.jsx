import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronLeftIcon, ChevronRightIcon, ArrowPathIcon } from '@heroicons/react/20/solid'
import EditorFrame from '@/components/voxmidi/studio/EditorFrame'
import { outlineBtn, plainBtn } from '@/components/voxmidi/studio/ui'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { scalePcs, SHARP_NAMES, FLAT_NAMES, parseKey } from '@/lib/studio/theory'
import { TRACK_COLORS, BEATS_PER_BAR, sectionRanges, updateTrack, trackById } from '@/lib/studio/project'

const PPB = 28   // px per beat
const ROW = 14   // px per semitone
const CHORD_LANE = 26
const VEL_LANE = 56
const EDITABLE = ['bass', 'chords', 'melody']

const q = (v, g) => Math.round(v / g) * g

function drag(e, onMove, onDone) {
  e.preventDefault()
  e.stopPropagation()
  const x0 = e.clientX, y0 = e.clientY
  const move = (ev) => onMove(ev.clientX - x0, ev.clientY - y0)
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    onDone?.()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function RollEditor() {
  const navigate = useNavigate()
  const { project, setProject, selTrack, setSelTrack, selSection, setSelSection, rewrite, toast } = useStudio()
  const trackId = EDITABLE.includes(selTrack) ? selTrack : 'bass'
  const track = trackById(project, trackId)
  const color = TRACK_COLORS[trackId]
  const secIndex = Math.min(selSection, project.sections.length - 1)
  const sec = project.sections[secIndex]
  const { start, end } = sectionRanges(project.sections)[secIndex]
  const beats = end - start
  const [sel, setSel] = useState(null) // index into track.notes
  const [busy, setBusy] = useState(false)
  const head = useRef(null)
  const scroller = useRef(null)

  const k = parseKey(project.key)
  const names = k?.flats ? FLAT_NAMES : SHARP_NAMES
  const scale = new Set(scalePcs(project.key))

  const inSec = track.notes.map((n, idx) => ({ n, idx })).filter(({ n }) => n.t >= start && n.t < end)
  const pitches = inSec.length ? inSec.map(({ n }) => n.p) : [48, 60]
  let lo = Math.min(...pitches) - 3
  let hi = Math.max(...pitches) + 3
  if (hi - lo < 24) { const pad = Math.ceil((24 - (hi - lo)) / 2); lo -= pad; hi += pad }
  const rows = hi - lo + 1

  useEffect(() => setSel(null), [trackId, secIndex])

  useEffect(() => engine.subscribe((b) => {
    if (!head.current) return
    const inside = b != null && b >= start && b < end
    head.current.style.opacity = inside ? '1' : '0'
    if (inside) head.current.style.transform = `translateX(${(b - start) * PPB}px)`
  }), [start, end])

  // Delete / Backspace removes the selected note
  useEffect(() => {
    function onKey(e) {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel != null) {
        e.preventDefault()
        removeSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const setNotes = (fn, opts) => setProject((p) => updateTrack(p, trackId, (t) => ({ notes: fn(t.notes) })), opts)
  const inRange = (n) => n.t >= start && n.t < end

  function removeSelected() {
    if (sel == null) return
    setNotes((ns) => ns.filter((_, i) => i !== sel), { what: `Deleted a ${track.name.toLowerCase()} note` })
    setSel(null)
  }

  function addNote(e) {
    if (e.button !== 0) return
    const r = e.currentTarget.getBoundingClientRect()
    const t = start + Math.max(0, q((e.clientX - r.left) / PPB - 0.125, 0.25))
    const p = hi - Math.floor((e.clientY - r.top) / ROW)
    const note = { p, t, d: 0.5, v: 90 }
    setNotes((ns) => [...ns, note], { what: `Added a ${track.name.toLowerCase()} note` })
    setSel(track.notes.length)
    engine.audition(track, note)
  }

  function moveNote(e, idx) {
    const n0 = track.notes[idx]
    setSel(idx)
    engine.audition(track, n0)
    let first = true
    let lastP = n0.p
    drag(e, (dx, dy) => {
      const t = Math.min(end - 0.25, Math.max(start, q(n0.t + dx / PPB, 0.25)))
      const p = Math.max(0, Math.min(127, n0.p - Math.round(dy / ROW)))
      if (p !== lastP) { engine.audition(track, { ...n0, p }); lastP = p }
      setNotes((ns) => ns.map((x, i) => (i === idx ? { ...x, t, p } : x)), { undoable: first, what: first ? `Moved a ${track.name.toLowerCase()} note` : undefined })
      first = false
    })
  }

  function resizeNote(e, idx) {
    const d0 = track.notes[idx].d
    setSel(idx)
    let first = true
    drag(e, (dx) => {
      const d = Math.max(0.125, q(d0 + dx / PPB, 0.125))
      setNotes((ns) => ns.map((x, i) => (i === idx ? { ...x, d } : x)), { undoable: first, what: first ? 'Changed a note length' : undefined })
      first = false
    })
  }

  function velNote(e, idx) {
    const v0 = track.notes[idx].v
    setSel(idx)
    let first = true
    drag(e, (dx, dy) => {
      const v = Math.round(Math.max(8, Math.min(127, v0 - (dy / VEL_LANE) * 127)))
      setNotes((ns) => ns.map((x, i) => (i === idx ? { ...x, v } : x)), { undoable: first, what: first ? 'Changed a velocity' : undefined })
      first = false
    })
  }

  const tools = [
    ['Quantize 1/8', () => { setNotes((ns) => ns.map((n) => (inRange(n) ? { ...n, t: q(n.t, 0.5) } : n)), { what: 'Quantized to eighths' }); toast('Quantized to eighths') }],
    ['Humanize', () => { setNotes((ns) => ns.map((n) => (inRange(n) ? { ...n, t: Math.max(start, n.t + (Math.random() - 0.5) * 0.08), v: Math.max(8, Math.min(127, Math.round(n.v + (Math.random() - 0.5) * 30))) } : n)), { what: 'Humanized' }); toast('Humanized') }],
    ['+12', () => setNotes((ns) => ns.map((n) => (inRange(n) ? { ...n, p: Math.min(127, n.p + 12) } : n)), { what: 'Up an octave' })],
    ['−12', () => setNotes((ns) => ns.map((n) => (inRange(n) ? { ...n, p: Math.max(0, n.p - 12) } : n)), { what: 'Down an octave' })],
    ['Delete', removeSelected, sel == null],
  ]

  async function regenSelection() {
    setBusy(true)
    try {
      await rewrite(trackId, { start, end, what: `Rewrote ${track.name} in the ${sec.kind}` })
      setSel(null)
      toast(`${sec.kind} rewritten, free`)
    } catch (err) {
      toast(err.message)
    } finally {
      setBusy(false)
    }
  }

  const chordCells = Array.from({ length: sec.bars }, (_, b) => sec.chords[b % sec.chords.length])

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-none flex flex-wrap items-center gap-x-2.5 gap-y-2 px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <button type="button" onClick={() => navigate('/song')} className={plainBtn}>
          <ChevronLeftIcon className="size-4" />
          Song
        </button>
        <span className="size-[9px] shrink-0 rounded-sm" style={{ background: color }} />
        <select value={trackId} onChange={(e) => setSelTrack(e.target.value)} className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-1.5 py-1 text-sm font-semibold text-zinc-900 dark:text-white">
          {EDITABLE.map((id) => <option key={id} value={id}>{trackById(project, id).name}</option>)}
        </select>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setSelSection(Math.max(0, secIndex - 1))} disabled={secIndex === 0} className={outlineBtn} aria-label="Previous section"><ChevronLeftIcon className="size-3.5" /></button>
          <span className="text-sm font-semibold text-zinc-900 dark:text-white min-w-[60px] text-center">{sec.kind}</span>
          <button type="button" onClick={() => setSelSection(Math.min(project.sections.length - 1, secIndex + 1))} disabled={secIndex >= project.sections.length - 1} className={outlineBtn} aria-label="Next section"><ChevronRightIcon className="size-3.5" /></button>
        </div>
        <span className="font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap">{inSec.length} notes · {sec.bars} bars · {track.sound}</span>
        <div className="flex-1" />
        {tools.map(([label, fn, disabled]) => (
          <button key={label} type="button" onClick={fn} disabled={disabled} className={clsx(outlineBtn, 'whitespace-nowrap', /\d/.test(label) && 'font-mono')}>{label}</button>
        ))}
        <button type="button" onClick={regenSelection} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-3 py-1.5 text-xs font-semibold text-white whitespace-nowrap">
          <ArrowPathIcon className={clsx('size-3.5', busy && 'animate-spin')} />
          Regenerate selection
        </button>
      </div>

      <div ref={scroller} className="flex-1 min-h-0 overflow-auto bg-canvas select-none">
        <div className="flex min-w-min">
          {/* Keys */}
          <div className="flex-none w-[52px] sticky left-0 z-[3] bg-zinc-900 border-r border-zinc-800">
            <div className="border-b border-zinc-800 bg-zinc-900" style={{ height: CHORD_LANE }} />
            {Array.from({ length: rows }, (_, i) => {
              const p = hi - i
              const pc = p % 12
              const black = [1, 3, 6, 8, 10].includes(pc)
              return (
                <div key={p} className={clsx('flex items-center justify-end pr-1.5 font-mono text-[8px] border-b border-white/[0.04]', scale.has(pc) ? 'text-indigo-300' : 'text-zinc-600')}
                  style={{ height: ROW, background: black ? 'var(--grid-lane-black)' : 'var(--grid-lane-white)' }}>
                  {pc === 0 ? `C${Math.floor(p / 12) - 1}` : names[pc]}
                </div>
              )
            })}
            <div className="border-t border-zinc-800" style={{ height: VEL_LANE }} />
          </div>

          <div className="flex-none">
            {/* Chord lane */}
            <div className="relative border-b border-zinc-800 bg-zinc-900" style={{ height: CHORD_LANE, width: beats * PPB }}>
              {chordCells.map((c, b) => (
                <div key={b} className="absolute top-1 h-[18px] flex items-center pl-1.5 rounded-[3px] bg-indigo-500/15 text-indigo-300 font-mono text-xs"
                  style={{ left: b * 4 * PPB, width: 4 * PPB - 2 }}>
                  {c}
                </div>
              ))}
            </div>

            {/* Grid */}
            <div onPointerDown={addNote} className="relative bg-canvas cursor-crosshair" style={{ width: beats * PPB, height: rows * ROW }}>
              {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="absolute inset-x-0 border-b border-white/[0.04] pointer-events-none"
                  style={{ top: i * ROW, height: ROW, background: scale.has((hi - i) % 12) ? 'rgb(99 102 241 / .07)' : 'transparent' }} />
              ))}
              {Array.from({ length: beats + 1 }, (_, i) => (
                <div key={i} className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: i * PPB, background: i % 4 === 0 ? 'var(--grid-line-measure)' : 'var(--grid-line)' }} />
              ))}
              {inSec.filter(({ n }) => n.glide).map(({ n, idx }) => (
                <div key={`g${idx}`} className="absolute h-0.5 z-[2] pointer-events-none"
                  style={{ left: (n.t - start) * PPB, top: (hi - n.p) * ROW + ROW / 2 - 1, width: n.d * PPB, background: 'repeating-linear-gradient(90deg, var(--amber-400) 0 3px, transparent 3px 6px)' }} />
              ))}
              {inSec.map(({ n, idx }) => (
                <div
                  key={idx}
                  onPointerDown={(e) => moveNote(e, idx)}
                  title={`${names[n.p % 12]}${Math.floor(n.p / 12) - 1} · velocity ${n.v}`}
                  className="absolute rounded-[2px] cursor-grab z-[4] touch-none"
                  style={{
                    left: (n.t - start) * PPB,
                    top: (hi - n.p) * ROW,
                    width: Math.max(6, n.d * PPB - 1),
                    height: ROW - 1,
                    background: color,
                    opacity: 0.4 + (n.v / 127) * 0.6,
                    boxShadow: sel === idx ? '0 0 0 1px #fff' : undefined,
                  }}
                >
                  <div onPointerDown={(e) => resizeNote(e, idx)} className="absolute right-0 top-0 w-1.5 h-full cursor-ew-resize" />
                </div>
              ))}
              <div ref={head} className="absolute left-0 top-0 w-px h-full pointer-events-none z-[6] opacity-0" style={{ background: 'var(--playhead)' }} />
            </div>

            {/* Velocity lane */}
            <div className="relative border-t border-zinc-800 bg-zinc-900" style={{ width: beats * PPB, height: VEL_LANE }}>
              {inSec.map(({ n, idx }) => (
                <div key={idx} onPointerDown={(e) => velNote(e, idx)} className="absolute bottom-0 w-1 rounded-t-[2px] cursor-ns-resize touch-none"
                  style={{ left: (n.t - start) * PPB, height: `${(n.v / 127) * 100}%`, background: sel === idx ? '#fff' : color }} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <p className="flex-none px-4 py-2 text-xs text-zinc-400 dark:text-zinc-500 border-t border-zinc-200 dark:border-zinc-800">
        Click the grid to add a note. Drag a note to move it, drag its right edge to change length, drag a velocity bar to change how hard it plays. Delete removes the selected note.
      </p>
    </div>
  )
}

export default function PianoRollPage() {
  return (
    <EditorFrame>
      <RollEditor />
    </EditorFrame>
  )
}
