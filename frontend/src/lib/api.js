const API_BASE = '/api'

// ─── Core API calls ───────────────────────────────────────────────────────────

export async function startGenerateMidi(formData, fetchFn = fetch) {
  const res = await fetchFn(`${API_BASE}/generate`, { method: 'POST', body: formData })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || `Generation failed: ${res.status}`)
  }
  return res.json() // { job_id, status }
}

export async function startExtractSource(formData, fetchFn = fetch) {
  const res = await fetchFn(`${API_BASE}/source`, { method: 'POST', body: formData })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || `Source extraction failed: ${res.status}`)
  }
  return res.json() // { job_id, status }
}

export async function getJobStatus(jobId, fetchFn = fetch) {
  const res = await fetchFn(`${API_BASE}/status/${jobId}`)
  if (!res.ok) {
    if (res.status === 404) return null
    throw new Error(`Status check failed: ${res.status}`)
  }
  return res.json()
}

export async function transcribeAudio(audioBlob, fetchFn = fetch) {
  const formData = new FormData()
  formData.append('audio', audioBlob, 'recording.webm')
  const res = await fetchFn(`${API_BASE}/transcribe`, { method: 'POST', body: formData })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || `Transcription failed: ${res.status}`)
  }
  return res.json()
}

export async function transformStyle(sourceJobId, stylePrompt, keepTracks, generateTracks, tempo = 128, key = 'Am', fetchFn = fetch) {
  const res = await fetchFn(`${API_BASE}/transform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_job_id: sourceJobId,
      style_prompt: stylePrompt,
      keep_tracks: keepTracks,
      generate_tracks: generateTracks,
      tempo,
      key,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || `Transform failed: ${res.status}`)
  }
  return res.json()
}

export async function getPresets(fetchFn = fetch) {
  const res = await fetchFn(`${API_BASE}/presets`)
  if (!res.ok) throw new Error(`Presets failed: ${res.status}`)
  return res.json()
}

// ─── Library (localStorage) ───────────────────────────────────────────────────

const LIBRARY_KEY = 'voxmidi_library'

export function saveToLibrary(result, { genre, tempo, key } = {}) {
  if (!result || !result.tracks?.length) return
  const library = getLibrary()
  const entry = {
    id: result.job_id || `local_${Date.now()}`,
    date: new Date().toISOString(),
    genre: genre || result.genre || 'unknown',
    tempo: result.tempo || tempo || 120,
    key: result.key || key || '?',
    tracks: result.tracks,
    midi_url: result.midi_url || null,
    audio_url: result.audio_url || null,
    vocal_audio_url: result.vocal_audio_url || null,
    duration: result.duration || 0,
    time_signature: result.time_signature || '4/4',
  }
  const updated = [entry, ...library].slice(0, 50)
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(updated))
  return entry
}

export function getLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_KEY) || '[]')
  } catch {
    return []
  }
}

export function deleteFromLibrary(id) {
  const library = getLibrary().filter((e) => e.id !== id)
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(library))
}

// ─── Sources (localStorage) ───────────────────────────────────────────────────

const SOURCES_KEY = 'voxmidi_sources'

export function saveSource(url, title = '') {
  const sources = getSources()
  if (sources.some((s) => s.url === url)) return
  const entry = { id: Date.now().toString(), url, title: title || url, date: new Date().toISOString() }
  const updated = [entry, ...sources].slice(0, 100)
  localStorage.setItem(SOURCES_KEY, JSON.stringify(updated))
  return entry
}

export function getSources() {
  try {
    return JSON.parse(localStorage.getItem(SOURCES_KEY) || '[]')
  } catch {
    return []
  }
}

export function deleteSource(id) {
  const sources = getSources().filter((s) => s.id !== id)
  localStorage.setItem(SOURCES_KEY, JSON.stringify(sources))
}

// ─── Settings (localStorage) ──────────────────────────────────────────────────

const SETTINGS_KEY = 'voxmidi_settings'

const DEFAULT_SETTINGS = {
  defaultDaw: 'garageband',
  midiResolution: '480',
  providerMode: 'mock',
  backendUrl: 'http://localhost:8080',
  replicateToken: '',
}

export function getSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

// ─── Client-side MIDI download ────────────────────────────────────────────────

export function downloadMidiClientSide(tracks, tempo, filename = 'voxmidi-output.mid') {
  import('@tonejs/midi').then(({ Midi }) => {
    const midi = new Midi()
    midi.header.setTempo(tempo)

    tracks.forEach((track) => {
      const midiTrack = midi.addTrack()
      midiTrack.name = track.name || 'Track'
      midiTrack.channel = track.is_drum ? 9 : (track.channel || 0)
      midiTrack.instrument.number = track.program || 0

      ;(track.notes || []).forEach((note) => {
        midiTrack.addNote({
          midi: note.pitch,
          time: note.start,
          duration: Math.max(note.end - note.start, 0.05),
          velocity: (note.velocity || 80) / 127,
        })
      })
    })

    const bytes = midi.toArray()
    const blob = new Blob([bytes], { type: 'audio/midi' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
}
