// "Ask" edits. Rule-based, not a language model: it reads which part, which
// section and which direction from the request, and says so plainly when it
// can't find them instead of guessing.

import { barMap, sectionRanges } from './project'

const PARTS = [
  { id: 'drums', words: ['hi-hat', 'hihat', 'hat', 'drum', 'kick', 'snare', 'beat', 'groove'] },
  { id: 'bass', words: ['808', 'bass', 'low end'] },
  { id: 'chords', words: ['chord', 'piano', 'keys', 'pad', 'harmony'] },
  { id: 'melody', words: ['melody', 'lead', 'top line', 'topline', 'hook'] },
]
const KINDS = ['intro', 'verse', 'chorus', 'bridge', 'outro']
const LESS = ['simpler', 'simple', 'less', 'sparse', 'calm', 'thin', 'quieter', 'softer', 'fewer', 'strip', 'lighter']
const MORE = ['busier', 'busy', 'more', 'denser', 'dense', 'harder', 'louder', 'bigger', 'firmer', 'fuller', 'add']
const HIGHER = ['higher', 'up an octave', 'octave up', 'brighter']
const LOWER = ['lower', 'down an octave', 'octave down', 'darker']

const has = (text, words) => words.some((w) => text.includes(w))

export const ASK_SUGGESTIONS = [
  'Make the hi-hats busier in the chorus',
  'Simpler bass in the verse',
  'Softer chords under the melody',
]

export function planAsk(project, text) {
  const low = ` ${text.toLowerCase()} `
  const part = PARTS.find((p) => has(low, p.words))
  if (!part) {
    return { error: "I couldn't tell which part to change. Name drums, bass, chords or melody, and a section if you like." }
  }
  const kind = KINDS.find((k) => low.includes(k))
  const sectionKind = kind ? kind[0].toUpperCase() + kind.slice(1) : null
  if (sectionKind && !project.sections.some((s) => s.kind === sectionKind)) {
    return { error: `This song has no ${kind}.` }
  }
  let dir = has(low, LESS) ? 'less' : has(low, MORE) ? 'more' : has(low, HIGHER) ? 'higher' : has(low, LOWER) ? 'lower' : null
  if (!dir) {
    return { error: 'Say how it should change: busier, simpler, softer, louder, higher or lower.' }
  }
  const track = project.tracks.find((t) => t.id === part.id)
  const map = barMap(project.sections)
  const inRange = (t) => {
    const b = map[Math.floor(t / 4)]
    return b && (!sectionKind || b.sec.kind === sectionKind)
  }
  const where = sectionKind ? `${sectionKind}` : 'Whole song'
  const before = track.notes
  let after = before
  let title = ''
  let detail = ''

  if (part.id === 'drums') {
    const hatsOnly = has(low, ['hat', 'hi-hat', 'hihat'])
    if (dir === 'less' || dir === 'lower') {
      after = before.filter((n) => !(inRange(n.t) && (n.p === 42 || n.p === 46) && Math.abs((n.t % 1) - Math.round(n.t % 1)) > 0.01 && Math.abs((n.t % 1) - 0.5) > 0.01))
      if (!hatsOnly) after = after.filter((n) => !(inRange(n.t) && n.p === 75))
      title = `${where} hats: thinned to straight 8ths.`
    } else {
      const extra = []
      map.forEach((b, bar) => {
        if (!inRange(bar * 4)) return
        const o = bar * 4
        for (let i = 0; i < 16; i++) {
          const t = o + i * 0.25
          if (!before.some((n) => n.p === 42 && Math.abs(n.t - t) < 0.1)) extra.push({ p: 42, t, d: 0.08, v: 36 + (i % 2 ? 0 : 12) })
        }
        if (b.idx % 4 === 3) [0, 1, 2].forEach((k) => extra.push({ p: 42, t: o + 3.5 + k / 6, d: 0.06, v: 40 + k * 8 }))
      })
      after = [...before, ...extra].sort((a, b) => a.t - b.t)
      title = `${where} hi-hats: 16ths with triplet rolls at phrase ends.`
    }
    detail = 'Kick and snare untouched, so the pocket stays the same.'
  } else if (part.id === 'bass') {
    if (dir === 'less') {
      after = before.filter((n) => !inRange(n.t) || n.t % 4 < 0.1 || Math.abs((n.t % 4) - 2) < 0.1)
      title = `${where} bass: roots on the 1 and the 3 only.`
    } else if (dir === 'more') {
      const extra = before.filter((n) => inRange(n.t) && n.t % 4 < 0.1).map((n) => ({ ...n, p: n.p + 12, t: n.t + 3.5, d: 0.4, v: 88, glide: true }))
      after = [...before, ...extra].sort((a, b) => a.t - b.t)
      title = `${where} bass: octave slides into each bar.`
    } else {
      const shift = dir === 'higher' ? 12 : -12
      after = before.map((n) => (inRange(n.t) ? { ...n, p: Math.max(24, Math.min(60, n.p + shift)) } : n))
      title = `${where} bass: moved an octave ${dir === 'higher' ? 'up' : 'down'}.`
    }
    detail = 'Timing kept, so it still locks to the kick.'
  } else if (part.id === 'chords') {
    if (dir === 'less' || dir === 'more') {
      const k = dir === 'less' ? 0.7 : 1.25
      after = before.map((n) => (inRange(n.t) ? { ...n, v: Math.max(12, Math.min(127, Math.round(n.v * k))), d: dir === 'less' ? n.d * 1.3 : n.d } : n))
      title = `${where} chords: ${dir === 'less' ? 'softer and held longer' : 'played firmer'}.`
    } else {
      const shift = dir === 'higher' ? 12 : -12
      after = before.map((n) => (inRange(n.t) ? { ...n, p: n.p + shift } : n))
      title = `${where} chords: voiced an octave ${dir === 'higher' ? 'up' : 'down'}.`
    }
    detail = 'Same voicings, same rhythm.'
  } else {
    const shift = dir === 'higher' ? 12 : dir === 'lower' ? -12 : 0
    const dv = dir === 'more' ? 14 : dir === 'less' ? -14 : 0
    after = before.map((n) => (inRange(n.t) ? { ...n, p: n.p + shift, v: Math.max(12, Math.min(127, n.v + dv)) } : n))
    title = `${where} melody: ${shift ? `moved an octave ${shift > 0 ? 'up' : 'down'}` : dir === 'more' ? 'pushed up in the mix' : 'pulled back'}.`
    detail = 'Rhythm and phrasing left alone.'
  }

  const changed = after.length !== before.length || after.some((n, i) => n !== before[i])
  if (!changed) return { error: `Nothing to change in the ${sectionKind ? kind : 'song'} for that part.` }
  return { trackId: part.id, trackName: track.name, title, detail, before, after, range: sectionKind ? sectionRanges(project.sections).filter((_, i) => project.sections[i].kind === sectionKind) : null }
}
