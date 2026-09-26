// Studio project model. A project is sections (with a chord cycle each) plus
// tracks. MIDI tracks hold notes measured in beats from the top of the song:
//   { p: pitch, t: start beat, d: length in beats, v: velocity 1-127,
//     glide?: bool, roll?: bool, flam?: bool }
// Audio tracks hold clips pointing at a recorded take:
//   { id, takeId, startBeat, offset (seconds trimmed from the take), duration (seconds) }

export const BEATS_PER_BAR = 4

export const SECTION_KINDS = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro']

export const SECTION_COLORS = {
  Intro: 'var(--zinc-700)',
  Verse: 'var(--indigo-700)',
  Chorus: 'var(--indigo-500)',
  Bridge: 'var(--violet-500)',
  Outro: 'var(--zinc-700)',
}

export const TRACK_COLORS = {
  drums: 'var(--track-1)',
  bass: 'var(--track-2)',
  chords: 'var(--track-6)',
  melody: 'var(--track-5)',
  guitar: 'var(--track-8)',
  vocals: 'var(--vocals)',
  drumsai: 'var(--track-3)',
  audio: 'var(--track-4)',
}

export const SOUNDS = {
  drums: ['Tight kit', 'Trap kit', 'Dusty breaks', 'Room kit'],
  bass: ['Warm bass', 'Sub 808', 'Picked bass', 'Round synth'],
  chords: ['Felt piano', 'Rhodes', 'Soft pad', 'Plucked keys'],
  melody: ['Soft pad', 'Bell lead', 'Felt piano', 'Breath synth'],
  guitar: ['Dry', 'Room verb', 'Warm tape'],
  vocals: ['Dry', 'Plate verb', 'Warm tape'],
  drumsai: ['Dry', 'Room verb', 'Warm tape'],
  audio: ['Dry', 'Room verb', 'Warm tape'],
}

// Studio drum lanes, GM notes
export const DRUM_LANES = [
  { id: 'kick', label: 'Kick', p: 36, color: 'var(--track-1)' },
  { id: 'snare', label: 'Snare', p: 38, color: 'var(--track-2)' },
  { id: 'clap', label: 'Clap', p: 39, color: 'var(--track-2)' },
  { id: 'chat', label: 'Closed hat', p: 42, color: 'var(--track-6)' },
  { id: 'ohat', label: 'Open hat', p: 46, color: 'var(--track-6)' },
  { id: 'perc', label: 'Perc', p: 75, color: 'var(--track-6)' },
]

export function totalBars(sections) {
  return sections.reduce((a, s) => a + s.bars, 0)
}

export function sectionStartBar(sections, id) {
  let b = 0
  for (const s of sections) {
    if (s.id === id) return b
    b += s.bars
  }
  return 0
}

export function barMap(sections) {
  const out = []
  for (const sec of sections) {
    const cyc = sec.chords.length ? sec.chords : ['C']
    for (let i = 0; i < sec.bars; i++) out.push({ sec, idx: i, chord: cyc[i % cyc.length] })
  }
  return out
}

export function projectName(prompt) {
  const words = (prompt || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return 'Untitled song'
  const name = words.slice(0, 4).join(' ')
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
}

export function slug(name) {
  return (name || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'song'
}

function audioTrack(id, name) {
  return { id, name, kind: 'audio', sound: 'Dry', mute: false, solo: false, vol: 75, notes: [], clips: [] }
}

// Server project (from /api/studio/compose) -> client project
export function fromServer(p) {
  const tracks = p.tracks.map((t) => ({ ...t, mute: false, solo: false, vol: t.id === 'drums' ? 85 : t.id === 'bass' ? 80 : 65, clips: [] }))
  tracks.push(audioTrack('guitar', 'Guitar'), audioTrack('vocals', 'Vocals'))
  return {
    id: p.id,
    name: projectName(p.prompt),
    prompt: p.prompt || '',
    tempo: p.tempo,
    key: p.key,
    time_signature: p.time_signature,
    genre: p.genre,
    feel: p.feel,
    seed: p.seed,
    groove: p.groove || null,
    fills: true,
    swing: 0,
    humanize: 0,
    sections: p.sections,
    tracks,
    history: [{ at: new Date().toISOString(), what: 'Wrote the song', prompt: p.prompt || '' }],
  }
}

// An empty project, for starting from a tapped groove or a recorded riff
export function blankProject({ tempo = 100, key = 'A minor', chords = ['Am'], bars = 8, name = 'Untitled song' } = {}) {
  const empty = (id, trackName, sound) => ({ id, name: trackName, kind: 'midi', sound, notes: [] })
  const p = fromServer({
    id: Math.random().toString(36).slice(2, 10),
    prompt: '',
    tempo,
    key,
    time_signature: '4/4',
    genre: 'Lo-fi',
    feel: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    sections: [{ id: 's1', kind: 'Verse', bars, chords }],
    tracks: [
      empty('drums', 'Drums', 'Tight kit'),
      empty('bass', '808 / Bass', 'Warm bass'),
      empty('chords', 'Chords', 'Felt piano'),
      empty('melody', 'Melody', 'Soft pad'),
    ],
  })
  return { ...p, name, history: [{ at: new Date().toISOString(), what: 'Started an empty song' }] }
}

// Beat ranges of each section, in song order
export function sectionRanges(sections) {
  let b = 0
  return sections.map((s) => {
    const r = { id: s.id, start: b * BEATS_PER_BAR, end: (b + s.bars) * BEATS_PER_BAR }
    b += s.bars
    return r
  })
}

// Reorder sections and carry each section's notes and clips with it
export function reorderSections(project, newOrder) {
  const oldRanges = Object.fromEntries(sectionRanges(project.sections).map((r) => [r.id, r]))
  const newRanges = Object.fromEntries(sectionRanges(newOrder).map((r) => [r.id, r]))
  const shift = (t) => {
    for (const id in oldRanges) {
      const o = oldRanges[id]
      if (t >= o.start && t < o.end) return t - o.start + newRanges[id].start
    }
    return t
  }
  return {
    ...project,
    sections: newOrder,
    tracks: project.tracks.map((tr) => ({
      ...tr,
      notes: tr.notes.map((n) => ({ ...n, t: shift(n.t) })).sort((a, b) => a.t - b.t),
      clips: (tr.clips || []).map((c) => ({ ...c, startBeat: shift(c.startBeat) })),
    })),
  }
}

// Insert a copy of section i right after it, notes included
export function duplicateSection(project, i) {
  const sec = project.sections[i]
  const ranges = sectionRanges(project.sections)
  const { start, end } = ranges[i]
  const len = end - start
  const copy = { ...sec, id: `${sec.id}-${Date.now().toString(36)}`, chords: [...sec.chords] }
  const sections = [...project.sections.slice(0, i + 1), copy, ...project.sections.slice(i + 1)]
  return {
    ...project,
    sections,
    tracks: project.tracks.map((tr) => {
      const moved = tr.notes.map((n) => (n.t >= end ? { ...n, t: n.t + len } : n))
      const copies = tr.notes.filter((n) => n.t >= start && n.t < end).map((n) => ({ ...n, t: n.t + len }))
      return {
        ...tr,
        notes: [...moved, ...copies].sort((a, b) => a.t - b.t),
        clips: (tr.clips || []).map((c) => (c.startBeat >= end ? { ...c, startBeat: c.startBeat + len } : c)),
      }
    }),
  }
}

export function appendSection(project, section) {
  return { ...project, sections: [...project.sections, section] }
}

// Replace a track's notes inside [start, end) with fresh ones
export function spliceNotes(notes, start, end, fresh) {
  return [...notes.filter((n) => n.t < start || n.t >= end), ...fresh].sort((a, b) => a.t - b.t)
}

export function updateTrack(project, id, patch) {
  return { ...project, tracks: project.tracks.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)) }
}

export function trackById(project, id) {
  return project?.tracks.find((t) => t.id === id) || null
}

export function formatBeat(b) {
  const bar = Math.floor(b / 4) + 1
  const beat = Math.floor(b % 4) + 1
  const tick = Math.floor((b % 1) * 100)
  return `${String(bar).padStart(3, '0')}.${beat}.${String(tick).padStart(2, '0')}`
}

// Remove section i and its notes and clips; everything after it moves up
export function removeSection(project, i) {
  const { start, end } = sectionRanges(project.sections)[i]
  const len = end - start
  return {
    ...project,
    sections: project.sections.filter((_, k) => k !== i),
    tracks: project.tracks.map((tr) => ({
      ...tr,
      notes: tr.notes.filter((n) => n.t < start || n.t >= end).map((n) => (n.t >= end ? { ...n, t: n.t - len } : n)),
      clips: (tr.clips || []).filter((c) => c.startBeat < start || c.startBeat >= end).map((c) => (c.startBeat >= end ? { ...c, startBeat: c.startBeat - len } : c)),
    })),
  }
}

// Fingerprint of everything that changes how the drum part sounds, so an AI
// render can tell when the pattern has moved on since it was made
export function drumSignature(project) {
  const d = trackById(project, 'drums')
  const parts = [project.tempo, project.swing, project.humanize, ...(d?.notes || []).map((n) => `${n.p}:${n.t}:${n.v}:${n.roll ? 'r' : ''}${n.flam ? 'f' : ''}`)]
  let h = 2166136261
  for (const ch of parts.join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return (h >>> 0).toString(36)
}

// A track's role decides its color, sounds, synth and how it regenerates. The
// four written parts and the recorded tracks use their id as their role;
// tracks you add carry an explicit role.
export const roleOf = (t) => t.role || t.id
export const isDrums = (t) => t.kind === 'midi' && roleOf(t) === 'drums'
export const colorOf = (t) => TRACK_COLORS[roleOf(t)] || TRACK_COLORS[t.kind === 'audio' ? 'audio' : 'chords']
export const soundsOf = (t) => SOUNDS[roleOf(t)] || SOUNDS[t.kind === 'audio' ? 'audio' : 'chords']
// Composer part that writes notes for a MIDI role
export const composerPart = (t) => ({ drums: 'drums', bass: 'bass', chords: 'chords', melody: 'melody' })[roleOf(t)] || 'melody'

export const NEW_TRACKS = [
  { role: 'drums', label: 'Drums', kind: 'midi', sound: 'Tight kit' },
  { role: 'bass', label: 'Bass', kind: 'midi', sound: 'Warm bass' },
  { role: 'chords', label: 'Keys', kind: 'midi', sound: 'Rhodes' },
  { role: 'melody', label: 'Lead', kind: 'midi', sound: 'Bell lead' },
  { role: 'audio', label: 'Audio', kind: 'audio', sound: 'Dry' },
]

export function makeTrack(project, role) {
  const spec = NEW_TRACKS.find((x) => x.role === role) || NEW_TRACKS[4]
  const n = project.tracks.filter((t) => roleOf(t) === role).length + 1
  return {
    id: `${role}-${Date.now().toString(36)}`,
    role,
    name: `${spec.label} ${n}`,
    kind: spec.kind,
    sound: spec.sound,
    mute: false, solo: false, vol: 75, notes: [], clips: [],
  }
}
