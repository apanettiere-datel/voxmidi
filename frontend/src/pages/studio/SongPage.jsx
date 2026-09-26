import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { PlusIcon, ChevronLeftIcon, ChevronRightIcon, DocumentDuplicateIcon, TrashIcon } from '@heroicons/react/20/solid'
import EditorFrame from '@/components/voxmidi/studio/EditorFrame'
import { Wave } from '@/components/voxmidi/studio/ui'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { diatonicChords } from '@/lib/studio/theory'
import {
  SECTION_COLORS, TRACK_COLORS, SOUNDS, BEATS_PER_BAR,
  totalBars, sectionRanges, reorderSections, duplicateSection, removeSection, appendSection, updateTrack,
} from '@/lib/studio/project'

const BW = 27        // px per bar
const RH = 64        // track row height
const RULER = 52

// ── Clip preview ───────────────────────────────────────────────────────────────

function MidiClip({ track, notes, start, end, label, onOpen, style }) {
  const lo = Math.min(...notes.map((n) => n.p)) - 1
  const hi = Math.max(...notes.map((n) => n.p)) + 1
  const rows = Math.max(6, hi - lo + 1)
  const stride = notes.length > 90 ? Math.ceil(notes.length / 90) : 1
  const color = TRACK_COLORS[track.id]
  return (
    <button type="button" data-clip onClick={onOpen} className="absolute top-1 overflow-hidden rounded-[3px] text-left" style={{ ...style, height: RH - 9, background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 40%, transparent)` }}>
      <div className="h-[13px] px-1 text-[9px] leading-[13px] whitespace-nowrap overflow-hidden" style={{ color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}>{label}</div>
      <svg viewBox={`0 0 ${end - start} ${rows}`} preserveAspectRatio="none" className="block w-full h-[calc(100%-13px)]">
        {notes.filter((_, k) => k % stride === 0).map((n, k) => (
          <rect key={k} x={n.t - start} y={hi - n.p} width={Math.max(0.12, n.d)} height="1" rx=".4" fill={color} opacity={0.45 + (n.v / 127) * 0.55} />
        ))}
      </svg>
    </button>
  )
}

// ── Track head ─────────────────────────────────────────────────────────────────

function TrackHead({ track, selected, onSelect, onRegen, busy }) {
  const { setProject } = useStudio()
  const set = (patch) => setProject((p) => updateTrack(p, track.id, patch), { undoable: false })
  const color = TRACK_COLORS[track.id]

  function volDrag(e) {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const at = (x) => Math.round(Math.max(0, Math.min(100, ((x - rect.left) / rect.width) * 100)))
    set({ vol: at(e.clientX) })
    const move = (ev) => set({ vol: at(ev.clientX) })
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div onClick={onSelect} className={clsx('flex flex-col justify-center gap-1.5 px-3 border-b border-zinc-200/60 dark:border-zinc-800/60 cursor-pointer', selected && 'bg-zinc-100 dark:bg-zinc-800')} style={{ height: RH }}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="size-[9px] shrink-0 rounded-sm" style={{ background: color }} />
        <span className="text-sm font-medium text-zinc-900 dark:text-white truncate">{track.name}</span>
        {track.kind === 'audio' && <span className="shrink-0 rounded-md bg-emerald-500/15 px-1.5 text-xs font-medium text-emerald-400">audio</span>}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRegen() }}
          disabled={busy}
          title={track.kind === 'audio' ? 'Audio tracks come from recording' : 'Regenerate this part, always free'}
          className={clsx('ml-auto size-5 shrink-0 rounded text-[13px] leading-none text-zinc-400 hover:text-indigo-300 disabled:opacity-40', busy && 'animate-spin')}
        >
          ↻
        </button>
      </div>
      <select
        value={track.sound}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => set({ sound: e.target.value })}
        className="h-6 rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-1.5 text-xs text-zinc-700 dark:text-zinc-300"
      >
        {SOUNDS[track.id].map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <div className="flex items-center gap-1.5">
        <button type="button" title="Mute" onClick={(e) => { e.stopPropagation(); set({ mute: !track.mute }) }}
          className={clsx('w-5 h-[18px] rounded border font-mono text-[10px]', track.mute ? 'bg-red-600 border-red-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 text-zinc-400')}>M</button>
        <button type="button" title="Solo" onClick={(e) => { e.stopPropagation(); set({ solo: !track.solo }) }}
          className={clsx('w-5 h-[18px] rounded border font-mono text-[10px]', track.solo ? 'bg-amber-500 border-amber-500 text-amber-950' : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 text-zinc-400')}>S</button>
        <div onPointerDown={volDrag} title="Volume" className="flex-1 h-1 rounded-full bg-zinc-200 dark:bg-zinc-800 cursor-ew-resize overflow-hidden touch-none">
          <div className="h-full" style={{ width: `${track.vol}%`, background: color }} />
        </div>
        <span className="font-mono tabular-nums text-[10px] text-zinc-400 dark:text-zinc-500 min-w-[26px] text-right">{track.vol}</span>
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

function SongTimeline() {
  const navigate = useNavigate()
  const { project, setProject, selTrack, setSelTrack, selSection, setSelSection, loopOn, play, stop, rewrite, takes, toast } = useStudio()
  const head = useRef(null)
  const [busy, setBusy] = useState({})

  const bars = totalBars(project.sections)
  const laneW = bars * BW
  const ranges = useMemo(() => sectionRanges(project.sections), [project.sections])
  const takeById = useMemo(() => Object.fromEntries(takes.map((t) => [t.id, t])), [takes])

  useEffect(() => engine.subscribe((b) => {
    if (head.current) head.current.style.transform = `translateX(${((b ?? 0) / BEATS_PER_BAR) * BW}px)`
  }), [])

  async function regenTrack(track) {
    if (track.kind === 'audio') { toast('Audio tracks come from recording'); return }
    setBusy((b) => ({ ...b, [track.id]: true }))
    try {
      await rewrite(track.id, { what: `Regenerated ${track.name}` })
      toast(`Rewrote ${track.name.toLowerCase()}, free`)
    } catch (e) {
      toast(e.message)
    } finally {
      setBusy((b) => ({ ...b, [track.id]: false }))
    }
  }

  function move(i, dir) {
    const j = i + dir
    if (j < 0 || j >= project.sections.length) return
    const order = project.sections.slice()
    order.splice(j, 0, order.splice(i, 1)[0])
    setProject((p) => reorderSections(p, order), { what: `Moved ${project.sections[i].kind}` })
    setSelSection(j)
  }

  function duplicate(i) {
    setProject((p) => duplicateSection(p, i), { what: `Duplicated ${project.sections[i].kind}` })
    setSelSection(i + 1)
    toast(`${project.sections[i].kind} duplicated`)
  }

  function remove(i) {
    if (project.sections.length <= 1) return
    setProject((p) => removeSection(p, i), { what: `Removed ${project.sections[i].kind}` })
    setSelSection(Math.max(0, i - 1))
  }

  async function addBridge() {
    const d = diatonicChords(project.key)
    const section = { id: `b${Date.now().toString(36)}`, kind: 'Bridge', bars: 8, chords: [d[3], d[5], d[1], d[4]] }
    const start = bars * BEATS_PER_BAR
    const end = start + 8 * BEATS_PER_BAR
    setProject((p) => appendSection(p, section), { what: 'Added a bridge' })
    setSelSection(project.sections.length)
    try {
      await Promise.all(['drums', 'bass', 'chords', 'melody'].map((id) => rewrite(id, { start, end, seed: project.seed })))
      toast('Bridge added')
    } catch (e) {
      toast(`Bridge added, but writing its parts failed: ${e.message}`)
    }
  }

  function scrub(e) {
    if (e.target.closest('[data-clip]')) return
    const r = e.currentTarget.getBoundingClientRect()
    const beat = Math.max(0, ((e.clientX - r.left) / BW) * BEATS_PER_BAR)
    stop()
    play(Math.floor(beat))
  }

  function openClip(track, secIndex) {
    setSelTrack(track.id)
    setSelSection(secIndex)
    navigate(track.id === 'drums' ? `/song/drums?bar=${ranges[secIndex].start / BEATS_PER_BAR}` : '/song/roll')
  }

  const loop = loopOn ? ranges[selSection] : null

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-app">
      <div className="flex min-w-min">

        {/* Track heads */}
        <div className="flex-none w-[248px] sticky left-0 z-10 bg-sidebar border-r border-zinc-200 dark:border-zinc-800">
          <div className="sticky top-0 z-10 flex items-center gap-1.5 px-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900" style={{ height: RULER }}>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">Song plan</span>
            <button type="button" onClick={addBridge} title="Add a bridge" className="ml-auto rounded-md px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-white/5">
              <PlusIcon className="size-3.5" />
            </button>
          </div>
          {project.tracks.map((t) => (
            <TrackHead key={t.id} track={t} selected={t.id === selTrack} busy={busy[t.id]} onSelect={() => setSelTrack(t.id)} onRegen={() => regenTrack(t)} />
          ))}
        </div>

        {/* Ruler + lanes */}
        <div className="flex-none relative">
          <div className="sticky top-0 z-[2] border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900" style={{ height: RULER, width: laneW }}>
            <div className="flex h-full items-stretch gap-0.5 py-1.5">
              {project.sections.map((s, i) => {
                const on = i === selSection
                return (
                  <div
                    key={s.id}
                    onClick={() => setSelSection(i)}
                    onDoubleClick={() => duplicate(i)}
                    className={clsx('flex-none min-w-0 px-1.5 py-1 rounded-[3px] cursor-pointer overflow-hidden border transition', on ? 'border-indigo-300' : 'border-transparent')}
                    style={{ width: s.bars * BW - 2, background: on ? SECTION_COLORS[s.kind] : `color-mix(in srgb, ${SECTION_COLORS[s.kind]} 60%, transparent)` }}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs font-semibold text-white whitespace-nowrap">{s.kind}</span>
                      <span className="font-mono tabular-nums text-xs text-zinc-300">{s.bars}</span>
                      {on && (
                        <span className="ml-auto flex gap-0.5">
                          {[
                            [ChevronLeftIcon, 'Move earlier', () => move(i, -1)],
                            [DocumentDuplicateIcon, 'Duplicate', () => duplicate(i)],
                            [ChevronRightIcon, 'Move later', () => move(i, 1)],
                            [TrashIcon, 'Remove', () => remove(i)],
                          ].map(([Icon, title, fn]) => (
                            <button key={title} type="button" title={title} onClick={(e) => { e.stopPropagation(); fn() }} className="grid place-items-center size-4 rounded-[3px] bg-white/10 text-zinc-200 hover:bg-white/20">
                              <Icon className="size-3" />
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-[3px] mt-1 overflow-hidden">
                      {s.chords.slice(0, 4).map((c, k) => (
                        <span key={k} className="font-mono text-[9px] px-1 py-px rounded-[3px] bg-white/10 text-zinc-200 whitespace-nowrap">{c}</span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div onPointerDown={scrub} className="relative" style={{ width: laneW, minHeight: project.tracks.length * RH }}>
            {Array.from({ length: bars + 1 }, (_, b) => (
              <div key={b} className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: b * BW, background: b % 4 === 0 ? 'var(--grid-line-measure)' : 'var(--grid-line)' }} />
            ))}
            {loop && <div className="absolute top-0 h-0.5 bg-indigo-400 z-[5]" style={{ left: (loop.start / 4) * BW, width: ((loop.end - loop.start) / 4) * BW }} />}

            {project.tracks.map((t) => {
              const clips = []
              if (t.kind === 'midi') {
                ranges.forEach((r, si) => {
                  const ns = t.notes.filter((n) => n.t >= r.start && n.t < r.end)
                  if (!ns.length) return
                  clips.push(
                    <MidiClip
                      key={r.id}
                      track={t}
                      notes={ns}
                      start={r.start}
                      end={r.end}
                      label={`${t.name} · ${project.sections[si].kind}`}
                      onOpen={() => openClip(t, si)}
                      style={{ left: (r.start / 4) * BW, width: ((r.end - r.start) / 4) * BW - 2 }}
                    />
                  )
                })
              } else {
                for (const c of t.clips || []) {
                  const take = takeById[c.takeId]
                  const beats = (c.duration * project.tempo) / 60
                  clips.push(
                    <button key={c.id} type="button" data-clip onClick={() => navigate('/record')} className="absolute top-1 overflow-hidden rounded-[3px] text-left"
                      style={{ left: (c.startBeat / 4) * BW, width: Math.max(8, (beats / 4) * BW - 2), height: RH - 9, background: `color-mix(in srgb, ${TRACK_COLORS[t.id]} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${TRACK_COLORS[t.id]} 40%, transparent)` }}>
                      <div className="h-[13px] px-1 text-[9px] leading-[13px] whitespace-nowrap overflow-hidden" style={{ color: TRACK_COLORS[t.id] }}>{t.name} · {take?.name || 'take'}</div>
                      {take && <Wave peaks={take.peaks} stroke={TRACK_COLORS[t.id]} height={RH - 24} />}
                    </button>
                  )
                }
              }
              return (
                <div key={t.id} className={clsx('relative border-b border-zinc-200/60 dark:border-zinc-800/60', t.id === selTrack && 'bg-white/[0.02]')} style={{ height: RH }}>
                  {clips}
                  {!clips.length && (
                    <button type="button" data-clip onClick={() => (t.kind === 'audio' ? navigate('/record') : regenTrack(t))}
                      className="absolute left-1 top-2 rounded-[3px] border border-dashed border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-200">
                      {t.kind === 'audio' ? 'Nothing recorded yet. Arm and play' : 'Empty. Write this part'}
                    </button>
                  )}
                </div>
              )
            })}
            <div ref={head} className="absolute left-0 top-0 w-px h-full pointer-events-none z-[6]" style={{ background: 'var(--playhead)' }} />
          </div>
        </div>
      </div>
      <p className="px-4 py-3 text-xs text-zinc-400 dark:text-zinc-500">
        Click a clip to edit it. Click an empty spot in the lanes to play from there. Double-click a section to duplicate it.
      </p>
    </div>
  )
}

export default function SongPage() {
  return (
    <EditorFrame>
      <SongTimeline />
    </EditorFrame>
  )
}
