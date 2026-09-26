import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import {
  PlusIcon, MinusIcon, ChevronLeftIcon, ChevronRightIcon, DocumentDuplicateIcon, TrashIcon, ScissorsIcon,
  ClipboardDocumentIcon, ClipboardIcon, ArrowPathIcon, ArrowUpTrayIcon, XMarkIcon,
} from '@heroicons/react/20/solid'
import EditorFrame from '@/components/voxmidi/studio/EditorFrame'
import { Wave } from '@/components/voxmidi/studio/ui'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { diatonicChords } from '@/lib/studio/theory'
import {
  SECTION_COLORS, BEATS_PER_BAR, NEW_TRACKS,
  totalBars, sectionRanges, reorderSections, duplicateSection, removeSection, appendSection, updateTrack,
  colorOf, soundsOf, isDrums, makeTrack, trackById,
} from '@/lib/studio/project'
import { clearRange, copyRange, pasteInto, splitAt, trimClip, clipEnd, snapTo, newId } from '@/lib/studio/edit'

const RH = 64        // track row height
const SECTIONS_H = 52
const BARS_H = 18
const SNAPS = [['Bar', 4], ['Beat', 1], ['1/16', 0.25], ['Off', 0]]
const tool = 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 disabled:opacity-35 disabled:hover:bg-transparent transition'

// ── MIDI preview (not interactive: the lane handles clicks) ────────────────────

function MidiClip({ track, notes, start, end, label, style }) {
  const lo = Math.min(...notes.map((n) => n.p)) - 1
  const hi = Math.max(...notes.map((n) => n.p)) + 1
  const rows = Math.max(6, hi - lo + 1)
  const stride = notes.length > 90 ? Math.ceil(notes.length / 90) : 1
  const color = colorOf(track)
  return (
    <div className="absolute top-1 overflow-hidden rounded-[3px] pointer-events-none" style={{ ...style, height: RH - 9, background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 40%, transparent)` }}>
      <div className="h-[13px] px-1 text-[9px] leading-[13px] whitespace-nowrap overflow-hidden" style={{ color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}>{label}</div>
      <svg viewBox={`0 0 ${end - start} ${rows}`} preserveAspectRatio="none" className="block w-full h-[calc(100%-13px)]">
        {notes.filter((_, k) => k % stride === 0).map((n, k) => (
          <rect key={k} x={n.t - start} y={hi - n.p} width={Math.max(0.12, n.d)} height="1" rx=".4" fill={color} opacity={0.45 + (n.v / 127) * 0.55} />
        ))}
      </svg>
    </div>
  )
}

// ── Track head ─────────────────────────────────────────────────────────────────

function TrackHead({ track, selected, onSelect, onRegen, onDelete, busy }) {
  const { setProject } = useStudio()
  const [renaming, setRenaming] = useState(false)
  const set = (patch) => setProject((p) => updateTrack(p, track.id, patch), { undoable: false })
  const color = colorOf(track)

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
    <div onClick={onSelect} className={clsx('group flex flex-col justify-center gap-1.5 px-3 border-b border-zinc-200/60 dark:border-zinc-800/60 cursor-pointer', selected && 'bg-zinc-100 dark:bg-zinc-800')} style={{ height: RH }}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="size-[9px] shrink-0 rounded-sm" style={{ background: color }} />
        {renaming ? (
          <input
            autoFocus
            defaultValue={track.name}
            maxLength={40}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { const v = e.target.value.trim(); if (v) setProject((p) => updateTrack(p, track.id, { name: v }), { what: `Renamed a track to ${v}` }); setRenaming(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setRenaming(false) }}
            className="min-w-0 flex-1 rounded border border-indigo-500 bg-zinc-900 px-1 text-sm text-white"
          />
        ) : (
          <span onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true) }} title="Double-click to rename" className="text-sm font-medium text-zinc-900 dark:text-white truncate">{track.name}</span>
        )}
        {track.kind === 'audio' && <span className="shrink-0 rounded-md bg-emerald-500/15 px-1.5 text-xs font-medium text-emerald-400">audio</span>}
        <button type="button" onClick={(e) => { e.stopPropagation(); onDelete() }} title="Delete this track"
          className="ml-auto size-5 shrink-0 grid place-items-center rounded text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100 transition">
          <TrashIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRegen() }}
          disabled={busy}
          title={track.kind === 'audio' ? 'Audio tracks come from recording or importing' : 'Regenerate this part, always free'}
          className={clsx('size-5 shrink-0 rounded text-[13px] leading-none text-zinc-400 hover:text-indigo-300 disabled:opacity-40', busy && 'animate-spin')}
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
        {soundsOf(track).map((s) => <option key={s} value={s}>{s}</option>)}
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
  const {
    project, setProject, selTrack, setSelTrack, selSection, setSelSection, loopOn, playing, play, stop,
    rewrite, takes, addTake, toast, cursor, setCursor, clipboard, setClipboard,
  } = useStudio()
  const head = useRef(null)
  const lanesRef = useRef(null)
  const scroller = useRef(null)
  const fileInput = useRef(null)
  const [busy, setBusy] = useState({})
  const [selClip, setSelClip] = useState(null)
  const [sel, setSel] = useState(null)          // { start, end, tracks: [ids] }
  const [BW, setBW] = useState(27)              // px per bar
  const [snap, setSnap] = useState(1)
  const [addOpen, setAddOpen] = useState(false)
  const [dropAt, setDropAt] = useState(null)

  const bars = totalBars(project.sections)
  const maxBeat = bars * BEATS_PER_BAR
  const laneW = bars * BW
  const spb = 60 / project.tempo
  const ranges = useMemo(() => sectionRanges(project.sections), [project.sections])
  const takeById = useMemo(() => Object.fromEntries(takes.map((t) => [t.id, t])), [takes])
  const ppb = BW / BEATS_PER_BAR // px per beat

  useEffect(() => engine.subscribe((b) => {
    if (!head.current) return
    head.current.style.opacity = b == null ? '0' : '1'
    if (b != null) head.current.style.transform = `translateX(${b * ppb}px)`
  }), [ppb])

  // ── Geometry ────────────────────────────────────────────────────────────────

  function beatAt(clientX, grid = snap) {
    const r = lanesRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(maxBeat, snapTo((clientX - r.left) / ppb, grid)))
  }
  function rowAt(clientY) {
    const r = lanesRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(project.tracks.length - 1, Math.floor((clientY - r.top) / RH)))
  }
  const selTracks = () => (sel ? project.tracks.filter((t) => sel.tracks.includes(t.id)) : [])

  // ── Lane pointer: click sets the cursor, drag selects a range ──────────────

  function laneDown(e) {
    if (e.button !== 0 || e.target.closest('[data-clip]')) return
    e.preventDefault()
    setSelClip(null)
    const b0 = beatAt(e.clientX)
    const r0 = rowAt(e.clientY)
    setSelTrack(project.tracks[r0].id)
    let dragging = false
    const x0 = e.clientX
    const move = (ev) => {
      if (!dragging && Math.abs(ev.clientX - x0) < 4) return
      dragging = true
      const b1 = beatAt(ev.clientX)
      const r1 = rowAt(ev.clientY)
      const [lo, hi] = [Math.min(r0, r1), Math.max(r0, r1)]
      setSel({ start: Math.min(b0, b1), end: Math.max(b0, b1), tracks: project.tracks.slice(lo, hi + 1).map((t) => t.id) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!dragging) {
        setSel(null)
        setCursor(b0)
        if (playing) { stop(); play(b0) }
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Bar strip: click sets the cursor, drag selects the range on every track
  function barsDown(e) {
    if (e.button !== 0) return
    e.preventDefault()
    const b0 = beatAt(e.clientX, snap || 1)
    let dragging = false
    const x0 = e.clientX
    const move = (ev) => {
      if (!dragging && Math.abs(ev.clientX - x0) < 4) return
      dragging = true
      const b1 = beatAt(ev.clientX, snap || 1)
      setSel({ start: Math.min(b0, b1), end: Math.max(b0, b1), tracks: project.tracks.map((t) => t.id) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!dragging) {
        setSel(null)
        setCursor(b0)
        if (playing) { stop(); play(b0) }
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Double-click a MIDI lane to open that part in its editor
  function laneDouble(e) {
    if (e.target.closest('[data-clip]')) return
    const t = project.tracks[rowAt(e.clientY)]
    if (t.kind !== 'midi') return
    const beat = beatAt(e.clientX, 0)
    const si = Math.max(0, ranges.findIndex((r) => beat >= r.start && beat < r.end))
    setSelTrack(t.id)
    setSelSection(si)
    navigate(isDrums(t) ? `/song/drums?bar=${Math.floor(beat / BEATS_PER_BAR)}${t.id !== 'drums' ? `&track=${t.id}` : ''}` : '/song/roll')
  }

  // ── Audio clips: drag the body to move, the edges to trim ─────────────────

  function clipDown(e, track, clip, mode) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSelClip(clip.id)
    setSelTrack(track.id)
    setSel(null)
    const x0 = e.clientX
    const takeDur = takeById[clip.takeId]?.duration ?? clip.offset + clip.duration
    let first = true
    const move = (ev) => {
      const dBeats = (ev.clientX - x0) / ppb
      let next
      if (mode === 'move') {
        const s = Math.max(0, Math.min(maxBeat - 0.25, snapTo(clip.startBeat + dBeats, snap)))
        if (s === clip.startBeat && first) return
        next = { ...clip, startBeat: s }
      } else {
        const edgeBeat = mode === 'start' ? clip.startBeat + dBeats : clipEnd(clip, spb) + dBeats
        next = trimClip(clip, mode, snapTo(edgeBeat, snap), spb, takeDur)
      }
      setProject((p) => updateTrack(p, track.id, (tr) => ({ clips: tr.clips.map((c) => (c.id === clip.id ? next : c)) })),
        { undoable: first, what: first ? `${mode === 'move' ? 'Moved' : 'Trimmed'} a ${track.name.toLowerCase()} clip` : undefined })
      first = false
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── Edit commands ───────────────────────────────────────────────────────────

  function selectedClip() {
    for (const t of project.tracks) {
      const c = (t.clips || []).find((x) => x.id === selClip)
      if (c) return { track: t, clip: c }
    }
    return null
  }

  // What a command acts on: the range selection, else the selected clip
  function target() {
    if (sel && sel.end > sel.start) return { start: sel.start, end: sel.end, tracks: selTracks() }
    const sc = selectedClip()
    if (sc) return { start: sc.clip.startBeat, end: clipEnd(sc.clip, spb), tracks: [sc.track], clip: sc }
    return null
  }

  function copy(silent) {
    const tg = target()
    if (!tg) { toast('Select a range or a clip first'); return null }
    const data = { length: tg.end - tg.start, items: tg.tracks.map((t) => ({ trackId: t.id, ...copyRange(t, tg.start, tg.end, spb) })) }
    setClipboard(data)
    if (!silent) toast(`Copied ${fmtBeats(data.length)}`)
    return tg
  }

  function del(what = 'Deleted') {
    const tg = target()
    if (!tg) { toast('Select a range or a clip first'); return }
    if (tg.clip) {
      setProject((p) => updateTrack(p, tg.clip.track.id, (tr) => ({ clips: tr.clips.filter((c) => c.id !== tg.clip.clip.id) })), { what: `${what} a ${tg.clip.track.name.toLowerCase()} clip` })
      setSelClip(null)
    } else {
      const ids = new Set(tg.tracks.map((t) => t.id))
      setProject((p) => ({ ...p, tracks: p.tracks.map((t) => (ids.has(t.id) ? clearRange(t, tg.start, tg.end, spb) : t)) }), { what: `${what} ${fmtBeats(tg.end - tg.start)} on ${tg.tracks.length} track${tg.tracks.length > 1 ? 's' : ''}` })
    }
  }

  function cut() {
    if (copy(true)) { del('Cut'); toast('Cut. Paste puts it at the cursor') }
  }

  function paste(at = cursor, data = clipboard) {
    if (!data) { toast('Nothing copied yet'); return }
    // One copied track pastes onto the selected track if it's the same kind
    const selT = trackById(project, selTrack)
    const map = (it) => (data.items.length === 1 && selT && selT.kind === it.kind ? selT.id : it.trackId)
    const plan = data.items.map((it) => ({ it, to: map(it) })).filter(({ to }) => trackById(project, to))
    if (!plan.length) { toast('Those tracks are gone. Select a track of the same kind'); return }
    if (at >= maxBeat) { toast('The cursor is at the end of the song'); return }
    setProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => {
        const hit = plan.find((x) => x.to === t.id)
        return hit ? pasteInto(t, hit.it, at, data.length, spb, maxBeat) : t
      }),
    }), { what: `Pasted ${fmtBeats(data.length)} at bar ${Math.floor(at / 4) + 1}` })
    setSel({ start: at, end: Math.min(maxBeat, at + data.length), tracks: plan.map((x) => x.to) })
    setSelClip(null)
    setCursor(Math.min(maxBeat, at + data.length))
  }

  function duplicate() {
    const tg = target()
    if (!tg) { toast('Select a range or a clip first'); return }
    const data = { length: tg.end - tg.start, items: tg.tracks.map((t) => ({ trackId: t.id, ...copyRange(t, tg.start, tg.end, spb) })) }
    if (tg.clip) {
      const { track, clip } = tg.clip
      const copyC = { ...clip, id: newId(), startBeat: clipEnd(clip, spb) }
      if (copyC.startBeat >= maxBeat) { toast('No room after this clip'); return }
      setProject((p) => updateTrack(p, track.id, (tr) => ({ clips: [...tr.clips, copyC] })), { what: `Duplicated a ${track.name.toLowerCase()} clip` })
      setSelClip(copyC.id)
      return
    }
    setSelTrack(tg.tracks[0].id)
    paste(tg.end, { ...data, items: data.items })
  }

  function split() {
    const sc = selectedClip()
    const tracks = sc ? [sc.track] : sel ? selTracks() : project.tracks.filter((t) => t.id === selTrack)
    if (!tracks.length) return
    const ids = new Set(tracks.map((t) => t.id))
    setProject((p) => ({ ...p, tracks: p.tracks.map((t) => (ids.has(t.id) ? splitAt(t, cursor, spb) : t)) }), { what: `Split at bar ${Math.floor(cursor / 4) + 1}` })
    toast(`Split at ${fmtPos(cursor)}`)
  }

  async function regenSelection() {
    const tg = target()
    const midi = tg?.tracks.filter((t) => t.kind === 'midi') || []
    if (!midi.length) { toast('Select a range on a drum, bass, keys or lead track'); return }
    setBusy((b) => Object.fromEntries([...Object.entries(b), ...midi.map((t) => [t.id, true])]))
    try {
      await Promise.all(midi.map((t) => rewrite(t.id, { start: tg.start, end: tg.end, what: `Rewrote ${t.name} in ${fmtBeats(tg.end - tg.start)}` })))
      toast(`Rewrote ${midi.length} part${midi.length > 1 ? 's' : ''} in the selection, free`)
    } catch (e) {
      toast(e.message)
    } finally {
      setBusy((b) => Object.fromEntries(Object.entries(b).filter(([k]) => !midi.some((t) => t.id === k))))
    }
  }

  // ── Tracks ──────────────────────────────────────────────────────────────────

  function addTrack(role) {
    const t = makeTrack(project, role)
    setProject((p) => ({ ...p, tracks: [...p.tracks, t] }), { what: `Added a track: ${t.name}` })
    setSelTrack(t.id)
    setAddOpen(false)
    toast(`${t.name} added${t.kind === 'midi' ? '. Use ↻ to write a part, or open it to draw one' : '. Import or record audio onto it'}`)
  }

  function deleteTrack(t) {
    setProject((p) => ({ ...p, tracks: p.tracks.filter((x) => x.id !== t.id) }), { what: `Deleted the ${t.name} track` })
    setSel((s) => (s ? { ...s, tracks: s.tracks.filter((id) => id !== t.id) } : s))
    toast(`${t.name} deleted. Undo brings it back`)
  }

  async function regenTrack(track) {
    if (track.id === 'drumsai') { navigate('/song/drums'); return }
    if (track.kind === 'audio') { toast('Audio tracks come from recording or importing'); return }
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

  // ── Import audio (button or drag and drop) ─────────────────────────────────

  async function importFiles(files, at = cursor, onTrackId = null) {
    const file = [...files].find((f) => f.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|flac|webm)$/i.test(f.name))
    if (!file) { toast('That file is not audio'); return }
    if (file.size > 100 * 1024 * 1024) { toast('Keep imports under 100 MB'); return }
    let buffer
    try {
      buffer = await engine.context().decodeAudioData(await file.arrayBuffer())
    } catch {
      toast(`Couldn't read ${file.name}. Try WAV or MP3`)
      return
    }
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 40)
    const take = await addTake(buffer, { name })
    const clip = { id: newId(), takeId: take.id, startBeat: Math.min(at, maxBeat - 0.25), offset: 0, duration: Math.min(buffer.duration, (maxBeat - at) * spb) }
    let dest = onTrackId ? trackById(project, onTrackId) : trackById(project, selTrack)
    setProject((p) => {
      let next = p
      if (!dest || dest.kind !== 'audio') {
        dest = { ...makeTrack(p, 'audio'), name: name || 'Audio' }
        next = { ...next, tracks: [...next.tracks, dest] }
      }
      return updateTrack(next, dest.id, (t) => ({ clips: [...(t.clips || []), clip] }))
    }, { what: `Imported ${file.name}` })
    setSelClip(clip.id)
    toast(buffer.duration > clip.duration + 0.05 ? `${name} placed, cut at the song end` : `${name} placed at ${fmtPos(at)}`)
  }

  function onDrop(e) {
    e.preventDefault()
    setDropAt(null)
    if (!e.dataTransfer.files?.length) return
    const t = project.tracks[rowAt(e.clientY)]
    importFiles(e.dataTransfer.files, beatAt(e.clientX), t?.kind === 'audio' ? t.id : null)
  }

  // ── Sections (from the design) ─────────────────────────────────────────────

  function moveSection(i, dir) {
    const j = i + dir
    if (j < 0 || j >= project.sections.length) return
    const order = project.sections.slice()
    order.splice(j, 0, order.splice(i, 1)[0])
    setProject((p) => reorderSections(p, order), { what: `Moved ${project.sections[i].kind}` })
    setSelSection(j)
  }
  function dupSection(i) {
    setProject((p) => duplicateSection(p, i), { what: `Duplicated ${project.sections[i].kind}` })
    setSelSection(i + 1)
    toast(`${project.sections[i].kind} duplicated`)
  }
  function removeSec(i) {
    if (project.sections.length <= 1) return
    setProject((p) => removeSection(p, i), { what: `Removed ${project.sections[i].kind}` })
    setSelSection(Math.max(0, i - 1))
  }
  async function addBridge() {
    const d = diatonicChords(project.key)
    const section = { id: `b${Date.now().toString(36)}`, kind: 'Bridge', bars: 8, chords: [d[3], d[5], d[1], d[4]] }
    const start = maxBeat
    const end = start + 8 * BEATS_PER_BAR
    setProject((p) => appendSection(p, section), { what: 'Added a bridge' })
    setSelSection(project.sections.length)
    try {
      await Promise.all(project.tracks.filter((t) => t.kind === 'midi').map((t) => rewrite(t.id, { start, end, seed: project.seed })))
      toast('Bridge added')
    } catch (e) {
      toast(`Bridge added, but writing its parts failed: ${e.message}`)
    }
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e) {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      if (mod && k === 'c') { e.preventDefault(); copy() }
      else if (mod && k === 'x') { e.preventDefault(); cut() }
      else if (mod && k === 'v') { e.preventDefault(); paste() }
      else if (mod && k === 'd') { e.preventDefault(); duplicate() }
      else if (mod && k === 'a') { e.preventDefault(); setSel({ start: 0, end: maxBeat, tracks: project.tracks.map((t) => t.id) }) }
      else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); del() }
      else if (!mod && k === 's') { e.preventDefault(); split() }
      else if (!mod && (k === '=' || k === '+')) setBW((w) => Math.min(120, Math.round(w * 1.25)))
      else if (!mod && k === '-') setBW((w) => Math.max(10, Math.round(w / 1.25)))
      else if (e.key === 'Escape') { setSel(null); setSelClip(null) }
      else if (e.key === 'Home') setCursor(0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Ctrl/Cmd + wheel zooms
  useEffect(() => {
    const el = scroller.current
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setBW((w) => Math.max(10, Math.min(120, Math.round(w * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const loop = loopOn ? ranges[selSection] : null
  const tg = target()
  const selRows = sel ? project.tracks.map((t, i) => (sel.tracks.includes(t.id) ? i : -1)).filter((i) => i >= 0) : []

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Edit toolbar */}
      <div className="flex-none flex flex-wrap items-center gap-x-1 gap-y-1 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <button type="button" className={tool} onClick={split} title="Split at the cursor (S)"><ScissorsIcon className="size-3.5" />Split</button>
        <button type="button" className={tool} onClick={cut} disabled={!tg} title="Cut (Ctrl+X)"><ScissorsIcon className="size-3.5 rotate-90" />Cut</button>
        <button type="button" className={tool} onClick={() => copy()} disabled={!tg} title="Copy (Ctrl+C)"><ClipboardDocumentIcon className="size-3.5" />Copy</button>
        <button type="button" className={tool} onClick={() => paste()} disabled={!clipboard} title="Paste at the cursor (Ctrl+V)"><ClipboardIcon className="size-3.5" />Paste</button>
        <button type="button" className={tool} onClick={duplicate} disabled={!tg} title="Duplicate right after (Ctrl+D)"><DocumentDuplicateIcon className="size-3.5" />Duplicate</button>
        <button type="button" className={tool} onClick={() => del()} disabled={!tg} title="Delete (Del)"><TrashIcon className="size-3.5" />Delete</button>
        <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
        <button type="button" className={clsx(tool, 'text-indigo-300')} onClick={regenSelection} disabled={!tg || !tg.tracks.some((t) => t.kind === 'midi')} title="Have the AI rewrite the selected range on MIDI tracks, free">
          <ArrowPathIcon className="size-3.5" />Regenerate selection
        </button>
        <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
        <button type="button" className={tool} onClick={() => fileInput.current.click()} title="Import an audio file at the cursor, or drop one on a lane"><ArrowUpTrayIcon className="size-3.5" />Import audio</button>
        <input ref={fileInput} type="file" accept="audio/*" className="hidden" onChange={(e) => { e.target.files.length && importFiles(e.target.files); e.target.value = '' }} />
        <div className="relative">
          <button type="button" className={tool} onClick={() => setAddOpen((v) => !v)} aria-expanded={addOpen}><PlusIcon className="size-3.5" />Add track</button>
          {addOpen && (
            <div className="absolute left-0 top-full mt-1 z-30 w-40 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg p-1">
              {NEW_TRACKS.map((n) => (
                <button key={n.role} type="button" onClick={() => addTrack(n.role)} className="w-full text-left rounded-md px-2 py-1.5 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/5">
                  {n.label}{n.kind === 'audio' ? ' (audio)' : ''}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1" />
        <span className="font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500 mr-2 whitespace-nowrap">
          {sel && sel.end > sel.start ? `${fmtPos(sel.start)} to ${fmtPos(sel.end)} · ${sel.tracks.length} track${sel.tracks.length > 1 ? 's' : ''}` : `Cursor ${fmtPos(cursor)}`}
        </span>
        {sel && <button type="button" className={tool} onClick={() => setSel(null)} title="Clear selection (Esc)"><XMarkIcon className="size-3.5" /></button>}
        <label className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          Snap
          <select value={snap} onChange={(e) => setSnap(Number(e.target.value))} className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-1 py-0.5 font-mono text-xs text-zinc-700 dark:text-zinc-300">
            {SNAPS.map(([l, v]) => <option key={l} value={v}>{l}</option>)}
          </select>
        </label>
        <button type="button" className={tool} onClick={() => setBW((w) => Math.max(10, Math.round(w / 1.25)))} title="Zoom out (-)"><MinusIcon className="size-3.5" /></button>
        <button type="button" className={tool} onClick={() => setBW((w) => Math.min(120, Math.round(w * 1.25)))} title="Zoom in (+)"><PlusIcon className="size-3.5" /></button>
      </div>

      <div ref={scroller} className="flex-1 min-h-0 overflow-auto bg-app">
        <div className="flex min-w-min">

          {/* Track heads */}
          <div className="flex-none w-[248px] sticky left-0 z-10 bg-sidebar border-r border-zinc-200 dark:border-zinc-800">
            <div className="sticky top-0 z-10 flex items-center gap-1.5 px-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900" style={{ height: SECTIONS_H + BARS_H }}>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">Song plan</span>
              <button type="button" onClick={addBridge} title="Add an 8-bar bridge at the end" className="ml-auto rounded-md px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-white/5">
                <PlusIcon className="size-3.5" />
              </button>
            </div>
            {project.tracks.map((t) => (
              <TrackHead key={t.id} track={t} selected={t.id === selTrack} busy={busy[t.id]} onSelect={() => setSelTrack(t.id)} onRegen={() => regenTrack(t)} onDelete={() => deleteTrack(t)} />
            ))}
          </div>

          {/* Ruler + lanes */}
          <div className="flex-none relative">
            <div className="sticky top-0 z-[7] border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900" style={{ width: laneW }}>
              <div className="flex items-stretch gap-0.5 py-1.5" style={{ height: SECTIONS_H }}>
                {project.sections.map((s, i) => {
                  const on = i === selSection
                  return (
                    <div
                      key={s.id}
                      onClick={() => { setSelSection(i); setSel({ start: ranges[i].start, end: ranges[i].end, tracks: project.tracks.map((t) => t.id) }) }}
                      onDoubleClick={() => dupSection(i)}
                      title="Click to select this section on every track. Double-click to duplicate it"
                      className={clsx('flex-none min-w-0 px-1.5 py-1 rounded-[3px] cursor-pointer overflow-hidden border transition', on ? 'border-indigo-300' : 'border-transparent')}
                      style={{ width: s.bars * BW - 2, background: on ? SECTION_COLORS[s.kind] : `color-mix(in srgb, ${SECTION_COLORS[s.kind]} 60%, transparent)` }}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-xs font-semibold text-white whitespace-nowrap">{s.kind}</span>
                        <span className="font-mono tabular-nums text-xs text-zinc-300">{s.bars}</span>
                        {on && s.bars * BW > 110 && (
                          <span className="ml-auto flex gap-0.5">
                            {[
                              [ChevronLeftIcon, 'Move earlier', () => moveSection(i, -1)],
                              [DocumentDuplicateIcon, 'Duplicate', () => dupSection(i)],
                              [ChevronRightIcon, 'Move later', () => moveSection(i, 1)],
                              [TrashIcon, 'Remove', () => removeSec(i)],
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
              {/* Bar numbers: click for the cursor, drag to select every track */}
              <div onPointerDown={barsDown} className="relative cursor-text select-none border-t border-zinc-200 dark:border-zinc-800" style={{ height: BARS_H }} title="Click to move the cursor, drag to select">
                {Array.from({ length: bars }, (_, b) => ((BW >= 18 || b % 4 === 0) && (
                  <span key={b} className="absolute top-0.5 font-mono tabular-nums text-[9px] text-zinc-500" style={{ left: b * BW + 2 }}>{b + 1}</span>
                )))}
                {sel && sel.end > sel.start && <div className="absolute bottom-0 h-1 bg-indigo-500/70" style={{ left: sel.start * ppb, width: (sel.end - sel.start) * ppb }} />}
                <div className="absolute top-0 bottom-0 w-0 border-l-[5px] border-r-[5px] border-t-[7px] border-transparent border-t-amber-400 -translate-x-[5px]" style={{ left: cursor * ppb }} />
              </div>
            </div>

            <div
              ref={lanesRef}
              onPointerDown={laneDown}
              onDoubleClick={laneDouble}
              onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropAt({ beat: beatAt(e.clientX), row: rowAt(e.clientY) }) } }}
              onDragLeave={() => setDropAt(null)}
              onDrop={onDrop}
              className="relative select-none"
              style={{ width: laneW, minHeight: project.tracks.length * RH }}
            >
              {Array.from({ length: bars + 1 }, (_, b) => (
                <div key={b} className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: b * BW, background: b % 4 === 0 ? 'var(--grid-line-measure)' : 'var(--grid-line)' }} />
              ))}
              {loop && <div className="absolute top-0 h-0.5 bg-indigo-400 z-[5]" style={{ left: loop.start * ppb, width: (loop.end - loop.start) * ppb }} />}

              {project.tracks.map((t) => {
                const color = colorOf(t)
                const clips = []
                if (t.kind === 'midi') {
                  ranges.forEach((r, si) => {
                    const ns = t.notes.filter((n) => n.t >= r.start && n.t < r.end)
                    if (!ns.length) return
                    clips.push(
                      <MidiClip key={r.id} track={t} notes={ns} start={r.start} end={r.end} label={`${t.name} · ${project.sections[si].kind}`}
                        style={{ left: r.start * ppb, width: (r.end - r.start) * ppb - 2 }} />
                    )
                  })
                } else {
                  for (const c of t.clips || []) {
                    const take = takeById[c.takeId]
                    const on = selClip === c.id
                    const peaks = take && take.peaks.slice(
                      Math.floor((c.offset / take.duration) * take.peaks.length),
                      Math.ceil(((c.offset + c.duration) / take.duration) * take.peaks.length),
                    )
                    const w = Math.max(8, (c.duration / spb) * ppb - 1)
                    clips.push(
                      <div key={c.id} data-clip onPointerDown={(e) => clipDown(e, t, c, 'move')} title="Drag to move, drag an edge to trim. S splits at the cursor, Del removes it"
                        className={clsx('absolute top-1 overflow-hidden rounded-[3px] cursor-grab touch-none', on && 'ring-1 ring-white z-[3]')}
                        style={{ left: c.startBeat * ppb, width: w, height: RH - 9, background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 40%, transparent)` }}>
                        <div className="h-[13px] px-1.5 text-[9px] leading-[13px] whitespace-nowrap overflow-hidden" style={{ color }}>{t.name} · {take?.name || 'take'}</div>
                        {peaks?.length > 1 && <Wave peaks={peaks} stroke={color} height={RH - 24} />}
                        <div onPointerDown={(e) => clipDown(e, t, c, 'start')} className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-white/30" title="Drag to trim the start" />
                        <div onPointerDown={(e) => clipDown(e, t, c, 'end')} className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-white/30" title="Drag to trim the end" />
                      </div>
                    )
                  }
                }
                return (
                  <div key={t.id} className={clsx('relative border-b border-zinc-200/60 dark:border-zinc-800/60', t.id === selTrack && 'bg-white/[0.02]')} style={{ height: RH }}>
                    {clips}
                    {!clips.length && (
                      <span className="absolute left-1 top-2 rounded-[3px] border border-dashed border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400 dark:text-zinc-500 pointer-events-none">
                        {t.kind === 'audio' ? 'Empty. Record, import, or drop an audio file here' : 'Empty. Press ↻ to write a part, or double-click to draw one'}
                      </span>
                    )}
                  </div>
                )
              })}

              {/* Range selection */}
              {sel && sel.end > sel.start && selRows.map((i) => (
                <div key={i} className="absolute pointer-events-none bg-indigo-500/15 border-x border-indigo-400/70 z-[4]" style={{ left: sel.start * ppb, width: (sel.end - sel.start) * ppb, top: i * RH, height: RH }} />
              ))}
              {dropAt && <div className="absolute pointer-events-none border-2 border-dashed border-emerald-400 rounded z-[8]" style={{ left: dropAt.beat * ppb, top: dropAt.row * RH, width: 4 * ppb, height: RH }} />}
              {/* Edit cursor and playhead */}
              <div className="absolute top-0 h-full w-px pointer-events-none z-[5] bg-amber-400/70" style={{ left: cursor * ppb }} />
              <div ref={head} className="absolute left-0 top-0 w-px h-full pointer-events-none z-[6] opacity-0" style={{ background: 'var(--playhead)' }} />
            </div>
          </div>
        </div>
        <p className="px-4 py-3 text-xs text-zinc-400 dark:text-zinc-500">
          Click to place the cursor, drag across lanes to select. Double-click a MIDI lane to edit its notes. Drag recorded clips to move them and their edges to trim. S splits, Ctrl+C / X / V / D copy, cut, paste and duplicate, Del deletes. Drop audio files on a lane to import them.
        </p>
      </div>
    </div>
  )
}

function fmtPos(beat) {
  const bar = Math.floor(beat / 4) + 1
  const b = Math.floor(beat % 4) + 1
  const sixteenth = Math.round((beat % 1) * 4) + 1
  return `${bar}.${b}.${sixteenth}`
}

function fmtBeats(beats) {
  const bars = beats / 4
  return Number.isInteger(bars) ? `${bars} bar${bars === 1 ? '' : 's'}` : `${Math.round(beats * 4) / 4} beats`
}

export default function SongPage() {
  return (
    <EditorFrame>
      <SongTimeline />
    </EditorFrame>
  )
}
