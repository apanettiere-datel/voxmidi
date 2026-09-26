// Range editing for the song timeline: copy, cut, paste, delete, split and
// trim, on MIDI notes and audio clips alike. Pure functions on one track at a
// time; beats are the unit, `spb` (seconds per beat) converts audio clip
// lengths. No imports, so it runs under plain Node for tests.

const EPS = 1e-6

let seq = 0
export const newId = (prefix = 'c') => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`

export const clipEnd = (c, spb) => c.startBeat + c.duration / spb

// Cut an audio clip at `beat`, returning the part before and after (either may be null)
export function splitClip(c, beat, spb) {
  const end = clipEnd(c, spb)
  if (beat <= c.startBeat + EPS) return [null, c]
  if (beat >= end - EPS) return [c, null]
  const head = (beat - c.startBeat) * spb
  return [
    { ...c, duration: head },
    { ...c, id: newId(), startBeat: beat, offset: c.offset + head, duration: c.duration - head },
  ]
}

// Everything in [a, b) removed. Notes that started earlier are shortened to end at a;
// clips crossing an edge are cut there.
export function clearRange(track, a, b, spb) {
  if (track.kind === 'midi') {
    return {
      ...track,
      notes: track.notes
        .filter((n) => n.t < a - EPS || n.t >= b - EPS)
        .map((n) => (n.t < a && n.t + n.d > a ? { ...n, d: Math.max(0.05, a - n.t) } : n)),
    }
  }
  const out = []
  for (const c of track.clips || []) {
    if (clipEnd(c, spb) <= a + EPS || c.startBeat >= b - EPS) { out.push(c); continue }
    const [before] = splitClip(c, a, spb)
    const [, after] = splitClip(c, b, spb)
    if (before && before.startBeat < a - EPS) out.push(before)
    if (after && clipEnd(after, spb) > b + EPS) out.push(after)
  }
  return { ...track, clips: out }
}

// Contents of [a, b), with times relative to a
export function copyRange(track, a, b, spb) {
  if (track.kind === 'midi') {
    return {
      kind: 'midi',
      notes: track.notes
        .filter((n) => n.t >= a - EPS && n.t < b - EPS)
        .map((n) => ({ ...n, t: n.t - a, d: Math.min(n.d, b - n.t) })),
    }
  }
  const clips = []
  for (const c of track.clips || []) {
    if (clipEnd(c, spb) <= a + EPS || c.startBeat >= b - EPS) continue
    let piece = c
    if (piece.startBeat < a) piece = splitClip(piece, a, spb)[1]
    if (clipEnd(piece, spb) > b) piece = splitClip(piece, b, spb)[0]
    if (piece) clips.push({ ...piece, id: newId(), startBeat: piece.startBeat - a })
  }
  return { kind: 'audio', clips }
}

// Put `data` (from copyRange) at `at`, replacing what was there. Content past
// `maxBeat` (the end of the song) is dropped.
export function pasteInto(track, data, at, length, spb, maxBeat) {
  if (data.kind !== track.kind) return track
  const end = Math.min(at + length, maxBeat)
  let t = clearRange(track, at, end, spb)
  if (track.kind === 'midi') {
    const fresh = data.notes
      .map((n) => ({ ...n, t: n.t + at }))
      .filter((n) => n.t < maxBeat - EPS)
      .map((n) => ({ ...n, d: Math.min(n.d, maxBeat - n.t) }))
    return { ...t, notes: [...t.notes, ...fresh].sort((x, y) => x.t - y.t) }
  }
  const fresh = []
  for (const c of data.clips) {
    let piece = { ...c, id: newId(), startBeat: c.startBeat + at }
    if (piece.startBeat >= maxBeat - EPS) continue
    if (clipEnd(piece, spb) > maxBeat) piece = splitClip(piece, maxBeat, spb)[0]
    fresh.push(piece)
  }
  return { ...t, clips: [...t.clips, ...fresh] }
}

// Split at `beat`: audio clips are cut in two, MIDI notes crossing it become two notes
export function splitAt(track, beat, spb) {
  if (track.kind === 'midi') {
    const out = []
    for (const n of track.notes) {
      if (n.t < beat - EPS && n.t + n.d > beat + EPS) {
        out.push({ ...n, d: beat - n.t }, { ...n, t: beat, d: n.t + n.d - beat })
      } else out.push(n)
    }
    return { ...track, notes: out.sort((x, y) => x.t - y.t) }
  }
  return { ...track, clips: (track.clips || []).flatMap((c) => splitClip(c, beat, spb).filter(Boolean)) }
}

// Drag a clip edge. `edge` is 'start' or 'end'; `beat` the new edge position.
// The start can't go before the take's first sample, the end not past its last.
export function trimClip(c, edge, beat, spb, takeDuration, minBeats = 0.25) {
  if (edge === 'start') {
    const earliest = c.startBeat - c.offset / spb
    const latest = clipEnd(c, spb) - minBeats
    const s = Math.max(earliest, Math.min(latest, beat), 0)
    const shift = (s - c.startBeat) * spb
    return { ...c, startBeat: s, offset: c.offset + shift, duration: c.duration - shift }
  }
  const latest = c.startBeat + (takeDuration - c.offset) / spb
  const e = Math.max(c.startBeat + minBeats, Math.min(latest, beat))
  return { ...c, duration: (e - c.startBeat) * spb }
}

export const snapTo = (beat, grid) => (grid ? Math.round(beat / grid) * grid : beat)
