// Studio state shared by every studio screen: the current project (with
// undo), transport, recorded takes, usage, toasts and the Ask log.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import { applyRender, takeName } from './renders'
import { engine } from './engine'
import { listTakes, saveTake, deleteTake, peaksOf } from './takes'
import { fromServer, totalBars, sectionRanges, spliceNotes, updateTrack, trackById, composerPart, BEATS_PER_BAR } from './project'
import { wavBytes } from './files'

const StudioContext = createContext(null)
const LEGACY_KEY = 'voxmidi.studio.project.v1'
const SONGS_KEY = 'voxmidi.studio.songs.v1' // [{ id, name, tempo, key, bars, updatedAt }]
const CURRENT_KEY = 'voxmidi.studio.current'
const songKey = (id) => `voxmidi.studio.song.${id}`
const LATENCY_KEY = 'voxmidi.studio.latency'
const RENDERS_KEY = 'voxmidi.studio.renders' // background renders still running
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

function summary(p) {
  return { id: p.id, name: p.name, tempo: p.tempo, key: p.key, bars: totalBars(p.sections), updatedAt: Date.now() }
}

// Songs live one per key, with a small index for the songs list. A project
// saved by the single-song version is moved into the list on first load.
function loadSongs() {
  let songs = load(SONGS_KEY, null)
  if (!songs) {
    const legacy = load(LEGACY_KEY, null)
    songs = []
    if (legacy?.id) {
      save(songKey(legacy.id), legacy)
      save(CURRENT_KEY, legacy.id)
      songs.push(summary(legacy))
    }
    save(SONGS_KEY, songs)
    save(LEGACY_KEY, null)
  }
  return songs
}

function takeIdsOf(p) {
  return new Set((p?.tracks || []).flatMap((t) => (t.clips || []).map((c) => c.takeId)))
}

async function readError(res) {
  const err = await res.json().catch(() => ({ detail: res.statusText }))
  return err.detail || `Request failed: ${res.status}`
}

export function StudioProvider({ children }) {
  const authFetch = useAuthFetch()
  const [songs, setSongs] = useState(loadSongs)
  const songsRef = useRef(songs)
  songsRef.current = songs
  const [project, setProjectState] = useState(() => {
    const id = load(CURRENT_KEY, null)
    return id ? load(songKey(id), null) : null
  })
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

  // Mixer moves (volume, mute, solo, sound) aren't undo steps, so undo and
  // redo keep the mixer as it is now
  const withMixer = (snap, now) => ({
    ...snap,
    tracks: snap.tracks.map((t) => {
      const cur = now.tracks.find((x) => x.id === t.id)
      return cur ? { ...t, vol: cur.vol, mute: cur.mute, solo: cur.solo, sound: cur.sound } : t
    }),
  })

  const undo = useCallback(() => {
    const prev = undoRef.current.pop()
    if (!prev) return
    redoRef.current.push(projectRef.current)
    const value = withMixer(prev, projectRef.current)
    projectRef.current = value
    setProjectState(value)
    bump((n) => n + 1)
  }, [])

  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    if (!next) return
    undoRef.current.push(projectRef.current)
    const value = withMixer(next, projectRef.current)
    projectRef.current = value
    setProjectState(value)
    bump((n) => n + 1)
  }, [])

  const persist = useCallback((p) => {
    save(CURRENT_KEY, p?.id ?? null)
    if (!p) return
    save(songKey(p.id), p)
    const next = [summary(p), ...songsRef.current.filter((x) => x.id !== p.id)]
    songsRef.current = next
    save(SONGS_KEY, next)
    setSongs(next)
  }, [])

  // Keep the cursor inside the song when it gets shorter
  useEffect(() => {
    if (project && cursorRef.current >= totalBars(project.sections) * BEATS_PER_BAR) setCursor(0)
  }, [project, setCursor])

  useEffect(() => {
    const t = setTimeout(() => persist(project), 300)
    engine.setProject(project)
    return () => clearTimeout(t)
  }, [project, persist])

  // Don't lose the last edit if the tab closes inside the save debounce
  useEffect(() => {
    const flush = () => persist(projectRef.current)
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [persist])

  // ── Songs list ──────────────────────────────────────────────────────────────

  const resetSession = useCallback(() => {
    engine.stop()
    setPlaying(false)
    setSelSection(0)
    setCursor(0)
    setAskLog([])
  }, [setCursor])

  const openSong = useCallback((id) => {
    if (projectRef.current?.id === id) return projectRef.current
    const p = load(songKey(id), null)
    if (!p) return null
    if (projectRef.current) persist(projectRef.current)
    resetSession()
    setProject(p, { undoable: false })
    return p
  }, [persist, resetSession, setProject])

  // Close the current song (it stays in the list) so a start screen begins a new one
  const closeSong = useCallback(() => {
    if (projectRef.current) persist(projectRef.current)
    resetSession()
    setProject(null, { undoable: false })
    save(CURRENT_KEY, null)
  }, [persist, resetSession, setProject])

  const renameSong = useCallback((id, name) => {
    const clean = name.trim().slice(0, 80)
    if (!clean) return
    if (projectRef.current?.id === id) {
      setProject((p) => ({ ...p, name: clean }), { undoable: false })
      return
    }
    const p = load(songKey(id), null)
    if (!p) return
    save(songKey(id), { ...p, name: clean })
    const next = songsRef.current.map((x) => (x.id === id ? { ...x, name: clean } : x))
    save(SONGS_KEY, next)
    setSongs(next)
  }, [setProject])

  const deleteSong = useCallback((id) => {
    const gone = id === projectRef.current?.id ? projectRef.current : load(songKey(id), null)
    if (id === projectRef.current?.id) {
      resetSession()
      setProject(null, { undoable: false })
      save(CURRENT_KEY, null)
    }
    save(songKey(id), null)
    const rest = songsRef.current.filter((x) => x.id !== id)
    save(SONGS_KEY, rest)
    setSongs(rest)
    // Recordings only this song used go with it; takes not on any song stay on the Record screen
    const kept = new Set(rest.flatMap((x) => [...takeIdsOf(load(songKey(x.id), null))]))
    const drop = [...takeIdsOf(gone)].filter((t) => !kept.has(t))
    drop.forEach((t) => { deleteTake(t); engine.takes.delete(t); blobs.current.delete(t) })
    if (drop.length) setTakes((prev) => prev.filter((t) => !drop.includes(t.id)))
  }, [resetSession, setProject])

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
    let start = from ?? (loop ? loop[0] : cursorRef.current)
    // From the end there's nothing to hear: start over
    if (start >= totalBars(p.sections) * BEATS_PER_BAR - 0.01) start = loop ? loop[0] : 0
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
      if (!projectRef.current || document.querySelector('[role=dialog]')) return
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

  // Takes list from IndexedDB. Audio is decoded on demand (the open song's
  // clips, or a take a screen asks for), not all at once.
  const blobs = useRef(new Map())
  const decoding = useRef(new Map())
  useEffect(() => {
    let alive = true
    listTakes().then((list) => {
      const metas = []
      for (const { blob, ...meta } of list) {
        blobs.current.set(meta.id, blob)
        metas.push(meta)
      }
      if (alive) setTakes((prev) => [...metas.filter((m) => !prev.some((t) => t.id === m.id)), ...prev])
    })
    return () => { alive = false }
  }, [])

  // Resolves to the take's AudioBuffer, or null if it's gone or won't decode
  const loadTake = useCallback((id) => {
    if (engine.takes.has(id)) return Promise.resolve(engine.takes.get(id))
    if (decoding.current.has(id)) return decoding.current.get(id)
    const blob = blobs.current.get(id)
    if (!blob) return Promise.resolve(null)
    const job = blob.arrayBuffer()
      .then((ab) => engine.context().decodeAudioData(ab))
      .then((buf) => { engine.takes.set(id, buf); return buf })
      .catch(() => null)
      .finally(() => decoding.current.delete(id))
    decoding.current.set(id, job)
    return job
  }, [])

  const loadTakes = useCallback((ids) => Promise.all([...new Set(ids)].map(loadTake)), [loadTake])

  // The open song's recordings get decoded as soon as they're known
  const clipTakes = (project?.tracks || []).flatMap((t) => (t.clips || []).map((c) => c.takeId)).join(',')
  useEffect(() => {
    if (clipTakes) loadTakes(clipTakes.split(','))
  }, [clipTakes, takes.length, loadTakes])

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
    // Encoded first: if the audio is too big to keep, nothing half-saved is left behind
    const blob = new Blob([wavBytes(buffer)], { type: 'audio/wav' })
    engine.takes.set(id, buffer)
    blobs.current.set(id, blob)
    setTakes((prev) => [...prev, meta])
    if (!(await saveTake({ ...meta, blob }))) toast("This browser's storage is full, so that recording won't survive a reload. Export or delete old songs to free space.")
    return meta
  }, [takes.length, toast])

  const setLatency = useCallback((ms) => {
    setLatencyState(ms)
    save(LATENCY_KEY, ms)
  }, [])

  // ── Background renders ──────────────────────────────────────────────────────
  // AI drums and real parts: { [jobId]: { kind, songId, target, trackId, signature } }.
  // Placed from here so leaving the panel (or the song) doesn't lose them.

  const { jobs, startJob, removeJob } = useJobs()
  const [renders, setRenders] = useState(() => load(RENDERS_KEY, {}))
  // Renders still running survive a reload: keep polling them
  useEffect(() => {
    for (const [jobId, info] of Object.entries(load(RENDERS_KEY, {}))) startJob(jobId, { label: info.label, kind: 'studio' })
  }, [startJob])
  useEffect(() => { save(RENDERS_KEY, Object.keys(renders).length ? renders : null) }, [renders])
  const [renderErrors, setRenderErrors] = useState({}) // `${songId}:${target}` -> message
  const handled = useRef(new Set())

  const startRender = useCallback((jobId, info) => {
    setRenders((r) => ({ ...r, [jobId]: info }))
    setRenderErrors((e) => { const next = { ...e }; delete next[`${info.songId}:${info.target}`]; return next })
    startJob(jobId, { label: info.label, kind: 'studio' })
  }, [startJob])

  const clearRenderError = useCallback((songId, target) => {
    setRenderErrors((e) => { const next = { ...e }; delete next[`${songId}:${target}`]; return next })
  }, [])

  useEffect(() => {
    for (const [jobId, info] of Object.entries(renders)) {
      const job = jobs[jobId]
      if (!job || handled.current.has(jobId)) continue
      if (!['complete', 'error', 'cancelled'].includes(job.status)) continue
      handled.current.add(jobId)
      const done = (error) => {
        if (error) setRenderErrors((e) => ({ ...e, [`${info.songId}:${info.target}`]: error }))
        setRenders((r) => { const next = { ...r }; delete next[jobId]; return next })
        removeJob(jobId)
        refreshUsage()
      }
      if (job.status !== 'complete' || !job.result) {
        done(job.status === 'cancelled' ? 'Cancelled. Nothing was placed.' : job.error || 'That render failed. Nothing was placed.')
        continue
      }
      const result = job.result
      ;(async () => {
        const res = await authFetch(result.audio_url)
        if (!res.ok) throw new Error(`download failed (${res.status})`)
        const buffer = await engine.context().decodeAudioData(await res.arrayBuffer())
        const current = projectRef.current?.id === info.songId
        const base = current ? projectRef.current : load(songKey(info.songId), null)
        if (!base) throw new Error('the song was deleted')
        const take = await addTake(buffer, { name: takeName(base, info, result) })
        if (projectRef.current?.id === info.songId) {
          const out = applyRender(projectRef.current, info, result, take)
          if (!out) throw new Error('that track was deleted')
          setProject(out.project, { what: out.what })
          toast(out.toast)
        } else {
          // Finished after you switched songs: place it in that song where it's saved
          const fresh = load(songKey(info.songId), null)
          if (!fresh) throw new Error('the song was deleted')
          const out = applyRender(fresh, info, result, take)
          if (!out) throw new Error('that track was deleted')
          const saved = { ...out.project, history: [...(out.project.history || []), { at: new Date().toISOString(), what: out.what }] }
          save(songKey(saved.id), saved)
          const next = songsRef.current.map((x) => (x.id === saved.id ? summary(saved) : x))
          save(SONGS_KEY, next)
          setSongs(next)
          toast(`${out.toast} in ${saved.name}`)
        }
      })().then(() => done(null), (e) => done(`Couldn't place the audio: ${e.message}`))
    }
  }, [jobs, renders, authFetch, removeJob, refreshUsage, addTake, setProject, toast])

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

  // A new song from the server joins the list; the previous one stays saved
  const openProject = useCallback((serverProject) => {
    if (projectRef.current) persist(projectRef.current)
    resetSession()
    const p = fromServer(serverProject)
    setProject(p, { undoable: false })
    setSelSection(Math.min(2, p.sections.length - 1))
    return p
  }, [persist, resetSession, setProject])

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
  const rewrite = useCallback(async (trackId, { start, end, seed, fills, what, undoable = true } = {}) => {
    const songId = projectRef.current?.id
    const notes = await regenerate(trackId, { start, end, seed, fills })
    const p = projectRef.current
    const songEnd = totalBars(p?.sections || []) * BEATS_PER_BAR
    const s = start ?? 0
    const e = end ?? songEnd
    // Dropped if you switched songs or undid the section while it was writing
    if (!p || p.id !== songId || e > songEnd || !trackById(p, trackId)) throw new Error('The song changed while that part was being written, so it was not placed')
    setProject((prev) => updateTrack(prev, trackId, (t) => ({ notes: spliceNotes(t.notes, s, e, notes) })), { what, undoable })
    return notes
  }, [regenerate, setProject])

  // hints: { tempo, start } for takes recorded to the click
  const analyzeRiff = useCallback(async (wavBlob, hints = {}) => {
    const form = new FormData()
    form.append('riff', wavBlob, 'riff.wav')
    if (hints.tempo) form.append('tempo', String(hints.tempo))
    if (hints.start != null) form.append('start', String(hints.start))
    if (hints.instrument) form.append('instrument', hints.instrument)
    const res = await authFetch('/api/studio/analyze-riff', { method: 'POST', body: form })
    if (!res.ok) throw new Error(await readError(res))
    return res.json()
  }, [authFetch])

  const value = useMemo(() => ({
    project, setProject, undo, redo, songs, openSong, closeSong, renameSong, deleteSong, canUndo: undoRef.current.length > 0, canRedo: redoRef.current.length > 0,
    usage, refreshUsage,
    selTrack, setSelTrack, selSection, setSelSection, cursor, setCursor, cursorRef, clipboard, setClipboard,
    playing, play, stop, togglePlay, loopOn, setLoopOn, metro, setMetro,
    takes, addTake, loadTake, loadTakes, latency, setLatency,
    askLog, setAskLog,
    toast, toastMsg,
    compose, openProject, regenerate, rewrite, analyzeRiff,
    renders, renderErrors, startRender, clearRenderError,
  }), [renders, renderErrors, startRender, clearRenderError, project, setProject, undo, redo, songs, openSong, closeSong, renameSong, deleteSong, usage, refreshUsage, selTrack, selSection, playing, play, stop, togglePlay,
    loopOn, metro, cursor, setCursor, clipboard, takes, addTake, loadTake, loadTakes, latency, setLatency, askLog, toast, toastMsg, compose, openProject, regenerate, rewrite, analyzeRiff])

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>
}

export function useStudio() {
  return useContext(StudioContext)
}
