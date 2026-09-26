// Studio state shared by every studio screen: the current project (with
// undo), transport, recorded takes, usage, toasts and the Ask log.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthFetch } from '@/lib/authFetch'
import { engine } from './engine'
import { listTakes, saveTake, peaksOf } from './takes'
import { fromServer, totalBars, sectionRanges, spliceNotes, updateTrack, trackById, composerPart, BEATS_PER_BAR } from './project'
import { wavBytes } from './files'

const StudioContext = createContext(null)
const STORE_KEY = 'voxmidi.studio.project.v1'
const LATENCY_KEY = 'voxmidi.studio.latency'
const UNDO_LIMIT = 60

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function save(key, value) {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full or blocked: the project still works for this session */
  }
}

async function readError(res) {
  const err = await res.json().catch(() => ({ detail: res.statusText }))
  return err.detail || `Request failed: ${res.status}`
}

export function StudioProvider({ children }) {
  const authFetch = useAuthFetch()
  const [project, setProjectState] = useState(() => load(STORE_KEY, null))
  const undoRef = useRef([])
  const redoRef = useRef([])
  const [, bump] = useState(0)

  const [usage, setUsage] = useState(null)
  const [selTrack, setSelTrack] = useState('bass')
  const [selSection, setSelSection] = useState(0)
  // Edit cursor (beats): where play starts, paste lands and split cuts
  const [cursor, setCursorState] = useState(0)
  const cursorRef = useRef(0)
  const setCursor = useCallback((b) => { cursorRef.current = Math.max(0, b); setCursorState(Math.max(0, b)) }, [])
  const [clipboard, setClipboard] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [loopOn, setLoopOn] = useState(false)
  const [metro, setMetro] = useState(false)
  const [takes, setTakes] = useState([])
  const [latency, setLatencyState] = useState(() => load(LATENCY_KEY, null))
  const [askLog, setAskLog] = useState([])
  const [toastMsg, setToastMsg] = useState(null)
  const toastTimer = useRef(null)

  // ── Project + undo ──────────────────────────────────────────────────────────

  const projectRef = useRef(project)
  projectRef.current = project

  // Undo snapshots are taken here, outside the state updater, so StrictMode's
  // double-invoked updaters can't record a step twice.
  const setProject = useCallback((next, { undoable = true, what } = {}) => {
    const prev = projectRef.current
    let value = typeof next === 'function' ? next(prev) : next
    if (value === prev) return
    if (undoable && prev && value && prev.id === value.id) {
      undoRef.current = [...undoRef.current.slice(-UNDO_LIMIT + 1), prev]
      redoRef.current = []
    } else if (!value || !prev || prev.id !== value.id) {
      undoRef.current = []
      redoRef.current = []
    }
    if (value && what) value = { ...value, history: [...(value.history || []), { at: new Date().toISOString(), what }].slice(-500) }
    projectRef.current = value
    setProjectState(value)
  }, [])

  const undo = useCallback(() => {
    const prev = undoRef.current.pop()
    if (!prev) return
    redoRef.current.push(projectRef.current)
    projectRef.current = prev
    setProjectState(prev)
    bump((n) => n + 1)
  }, [])

  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    if (!next) return
    undoRef.current.push(projectRef.current)
    projectRef.current = next
    setProjectState(next)
    bump((n) => n + 1)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => save(STORE_KEY, project), 300)
    engine.setProject(project)
    return () => clearTimeout(t)
  }, [project])

  // Don't lose the last edit if the tab closes inside the save debounce
  useEffect(() => {
    const flush = () => save(STORE_KEY, projectRef.current)
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

  // ── Toast ───────────────────────────────────────────────────────────────────

  const toast = useCallback((msg) => {
    setToastMsg(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400)
  }, [])

  // ── Usage ───────────────────────────────────────────────────────────────────

  const refreshUsage = useCallback(() => {
    authFetch('/api/usage')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setUsage({ used: d.used, limit: d.limit }))
      .catch(() => {})
  }, [authFetch])

  useEffect(() => { refreshUsage() }, [refreshUsage])

  // ── Transport ───────────────────────────────────────────────────────────────

  useEffect(() => engine.subscribe((b) => { if (b === null) setPlaying(false) }), [])

  const loopRange = useCallback(() => {
    const p = projectRef.current
    if (!loopOn || !p) return null
    const r = sectionRanges(p.sections)[selSection] || sectionRanges(p.sections)[0]
    return [r.start, r.end]
  }, [loopOn, selSection])

  const play = useCallback((from) => {
    const p = projectRef.current
    if (!p) return
    const loop = loopRange()
    const start = from ?? (loop ? loop[0] : cursorRef.current)
    engine.play(p, { from: start, loop, metronome: metro, onEnd: () => setPlaying(false) })
    setPlaying(true)
  }, [loopRange, metro])

  const stop = useCallback(() => {
    engine.stop()
    setPlaying(false)
  }, [])

  const togglePlay = useCallback(() => {
    if (engine.playing) stop()
    else play()
  }, [play, stop])

  // Loop and metronome changes apply to the running transport
  useEffect(() => {
    if (!engine.playing) return
    engine.loop = loopRange()
    engine.metronome = metro
  }, [loopRange, metro])

  // Space plays, Cmd/Ctrl+Z undoes, while no field has focus
  useEffect(() => {
    function onKey(e) {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
      if (!projectRef.current) return
      if (e.code === 'Space' && !e.repeat && window.location.pathname.startsWith('/song')) {
        e.preventDefault()
        togglePlay()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? redo() : undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, undo, redo])

  useEffect(() => () => engine.stop(), [])

  // ── Takes ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true
    listTakes().then(async (list) => {
      // Publish the list only once the audio is decoded, so a screen that
      // reads engine.takes for a listed take always finds it
      const ctx = engine.context()
      const ready = []
      for (const { blob, ...meta } of list) {
        try {
          engine.takes.set(meta.id, await ctx.decodeAudioData(await blob.arrayBuffer()))
          ready.push(meta)
        } catch {
          /* a take that no longer decodes is skipped */
        }
      }
      if (alive) setTakes((prev) => [...ready, ...prev.filter((t) => !ready.some((r) => r.id === t.id))])
    })
    return () => { alive = false }
  }, [])

  const addTake = useCallback(async (buffer, extra = {}) => {
    const id = `take-${Date.now().toString(36)}`
    const meta = {
      id,
      name: `Take ${takes.length + 1}`,
      duration: buffer.duration,
      peaks: peaksOf(buffer),
      createdAt: Date.now(),
      ...extra,
    }
    engine.takes.set(id, buffer)
    setTakes((prev) => [...prev, meta])
    await saveTake({ ...meta, blob: new Blob([wavBytes(buffer)], { type: 'audio/wav' }) })
    return meta
  }, [takes.length])

  const setLatency = useCallback((ms) => {
    setLatencyState(ms)
    save(LATENCY_KEY, ms)
  }, [])

  // ── API ─────────────────────────────────────────────────────────────────────

  const compose = useCallback(async (body) => {
    const res = await authFetch('/api/studio/compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = new Error(await readError(res))
      err.status = res.status
      throw err
    }
    const data = await res.json()
    if (data.usage) setUsage(data.usage)
    return data
  }, [authFetch])

  const openProject = useCallback((serverProject) => {
    engine.stop()
    const p = fromServer(serverProject)
    setProject(p, { undoable: false })
    setSelSection(Math.min(2, p.sections.length - 1))
    setAskLog([])
    return p
  }, [setProject])

  // Fresh notes for one track, optionally only inside [start, end) beats. Free.
  const regenerate = useCallback(async (trackId, { start = null, end = null, seed, fills } = {}) => {
    const p = projectRef.current
    const res = await authFetch('/api/studio/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        track: composerPart(trackById(p, trackId) || { id: trackId }),
        key: p.key,
        genre: p.genre,
        feel: p.feel,
        sections: p.sections.map(({ id, kind, bars, chords }) => ({ id, kind, bars, chords })),
        start_beat: start,
        end_beat: end,
        seed: seed ?? Math.floor(Math.random() * 2 ** 31),
        fills: fills ?? p.fills,
        groove: p.groove || null,
      }),
    })
    if (!res.ok) throw new Error(await readError(res))
    const data = await res.json()
    return data.notes
  }, [authFetch])

  // Regenerate and splice into the project in one step
  const rewrite = useCallback(async (trackId, { start, end, seed, fills, what } = {}) => {
    const notes = await regenerate(trackId, { start, end, seed, fills })
    const p = projectRef.current
    const s = start ?? 0
    const e = end ?? totalBars(p.sections) * BEATS_PER_BAR
    setProject((prev) => updateTrack(prev, trackId, (t) => ({ notes: spliceNotes(t.notes, s, e, notes) })), { what })
    return notes
  }, [regenerate, setProject])

  // hints: { tempo, start } for takes recorded to the click
  const analyzeRiff = useCallback(async (wavBlob, hints = {}) => {
    const form = new FormData()
    form.append('riff', wavBlob, 'riff.wav')
    if (hints.tempo) form.append('tempo', String(hints.tempo))
    if (hints.start != null) form.append('start', String(hints.start))
    const res = await authFetch('/api/studio/analyze-riff', { method: 'POST', body: form })
    if (!res.ok) throw new Error(await readError(res))
    return res.json()
  }, [authFetch])

  const value = useMemo(() => ({
    project, setProject, undo, redo, canUndo: undoRef.current.length > 0, canRedo: redoRef.current.length > 0,
    usage, refreshUsage,
    selTrack, setSelTrack, selSection, setSelSection, cursor, setCursor, cursorRef, clipboard, setClipboard,
    playing, play, stop, togglePlay, loopOn, setLoopOn, metro, setMetro,
    takes, addTake, latency, setLatency,
    askLog, setAskLog,
    toast, toastMsg,
    compose, openProject, regenerate, rewrite, analyzeRiff,
  }), [project, setProject, undo, redo, usage, refreshUsage, selTrack, selSection, playing, play, stop, togglePlay,
    loopOn, metro, cursor, setCursor, clipboard, takes, addTake, latency, setLatency, askLog, toast, toastMsg, compose, openProject, regenerate, rewrite, analyzeRiff])

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>
}

export function useStudio() {
  return useContext(StudioContext)
}
