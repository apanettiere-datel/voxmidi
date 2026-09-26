// Music theory helpers shared by the studio screens. Mirrors the spelling
// rules in backend/app/pipelines/composer.py so names round-trip exactly.

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6])
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3])
const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10]

const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 }
const INTERVALS = { '': [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10] }

export function parseKey(name) {
  const m = /^([A-G][#b]?) (major|minor)$/.exec(name || '')
  if (!m || PC[m[1]] === undefined) return null
  const root = PC[m[1]]
  const mode = m[2]
  const flats = (mode === 'minor' ? FLAT_MINOR : FLAT_MAJOR).has(root)
  return { root, mode, flats, name }
}

export function keyName(root, mode) {
  const flats = (mode === 'minor' ? FLAT_MINOR : FLAT_MAJOR).has(root)
  return `${(flats ? FLAT_NAMES : SHARP_NAMES)[root]} ${mode}`
}

// All 24 keys, minor first since most prompts land there
export const ALL_KEYS = [
  ...Array.from({ length: 12 }, (_, r) => keyName(r, 'minor')),
  ...Array.from({ length: 12 }, (_, r) => keyName(r, 'major')),
]

export function shortKey(name) {
  const k = parseKey(name)
  if (!k) return name || ''
  return name.split(' ')[0] + (k.mode === 'minor' ? 'm' : '')
}

export function scalePcs(keyStr) {
  const k = parseKey(keyStr)
  if (!k) return MINOR.map((s) => (9 + s) % 12)
  return (k.mode === 'minor' ? MINOR : MAJOR).map((s) => (k.root + s) % 12)
}

export function parseChord(name) {
  const m = /^([A-G][#b]?)(maj7|m7b5|m7|dim|m|7)?$/.exec((name || '').trim())
  if (!m || PC[m[1]] === undefined) return null
  const q = m[2] || ''
  return { root: PC[m[1]], quality: q, intervals: INTERVALS[q] }
}

export function chordPcs(name) {
  const c = parseChord(name)
  return c ? c.intervals.map((i) => (c.root + i) % 12) : []
}

// Diatonic triads (and sevenths) of a key, spelled for that key
export function diatonicChords(keyStr, sevenths = false) {
  const k = parseKey(keyStr) || parseKey('A minor')
  const sc = (k.mode === 'minor' ? MINOR : MAJOR).map((s) => (k.root + s) % 12)
  const names = k.flats ? FLAT_NAMES : SHARP_NAMES
  return sc.map((root, d) => {
    const tone = (j) => (sc[(d + j) % 7] - root + 12) % 12
    const third = tone(2), fifth = tone(4), seventh = tone(6)
    let q
    if (third === 4) q = sevenths ? (seventh === 11 ? 'maj7' : '7') : ''
    else if (fifth === 6) q = sevenths ? 'm7b5' : 'dim'
    else q = sevenths ? 'm7' : 'm'
    return names[root] + q
  })
}

export function noteName(p, flats = false) {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[p % 12] + (Math.floor(p / 12) - 1)
}

export function isBlackKey(p) {
  return [1, 3, 6, 8, 10].includes(p % 12)
}
