// Server renders (AI drums, real-instrument parts) finish in the background.
// The studio context places their audio, so a render survives leaving the
// panel that started it. These build the project change for a finished render.

import { trackById, updateTrack, makeTrack } from './project'

export const DRUM_STYLES = [
  { id: 'acoustic', label: 'Acoustic kit' },
  { id: 'rock', label: 'Rock room' },
  { id: 'breaks', label: 'Vintage breaks' },
  { id: 'trap', label: 'Trap 808' },
  { id: 'brushes', label: 'Brushed jazz' },
  { id: 'electronic', label: 'Drum machine' },
]

// Styles per part, matching backend/app/pipelines/part_render.py
export const PART_STYLES = {
  bass: [['finger', 'Finger bass'], ['pick', 'Pick bass'], ['slap', 'Slap bass'], ['upright', 'Upright bass'], ['synth', 'Synth bass']],
  guitar: [['clean', 'Clean electric'], ['acoustic', 'Acoustic'], ['crunch', 'Crunch'], ['distorted', 'Distorted'], ['nylon', 'Nylon']],
  keys: [['piano', 'Piano'], ['rhodes', 'Rhodes'], ['organ', 'Organ'], ['pad', 'Pad']],
  lead: [['guitar', 'Lead guitar'], ['piano', 'Piano'], ['synth', 'Synth lead'], ['flute', 'Flute']],
}

export const partStyleLabel = (part, style) => PART_STYLES[part]?.find(([id]) => id === style)?.[1] || style

// A short hash of a part's notes, to tell when a render no longer matches them
export function noteSignature(notes) {
  let h = 2166136261
  for (const ch of notes.map((n) => `${n.p}:${n.t}:${n.d}:${n.v}`).join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return (h >>> 0).toString(36)
}

export function takeName(project, info, result) {
  if (info.kind === 'drums') return `AI drums · ${DRUM_STYLES.find((s) => s.id === result.style)?.label || 'AI'}`
  const track = trackById(project, info.trackId)
  return `${track?.name || 'Part'} · ${partStyleLabel(result.part, result.style)}${result.polish ? ' · AI' : ''}`
}

// Returns { project, what, toast }, or null when the target track is gone
export function applyRender(p, info, result, take) {
  const clipId = `r${Date.now().toString(36)}`
  const clip = { id: clipId, takeId: take.id, startBeat: 0, offset: 0, duration: take.duration }

  if (info.kind === 'drums') {
    if (!trackById(p, 'drums')) return null
    let next = p
    if (!trackById(next, 'drumsai')) {
      const at = next.tracks.findIndex((t) => t.id === 'drums') + 1
      const track = { id: 'drumsai', name: 'AI drums', kind: 'audio', sound: 'Dry', mute: false, solo: false, vol: 85, notes: [], clips: [] }
      next = { ...next, tracks: [...next.tracks.slice(0, at), track, ...next.tracks.slice(at)] }
    }
    next = updateTrack(next, 'drumsai', { clips: [clip], mute: false })
    next = updateTrack(next, 'drums', { mute: true })
    next = { ...next, aiDrums: { style: result.style, provider: result.provider, match: result.match, offsetMs: result.offset_ms, signature: info.signature } }
    const label = DRUM_STYLES.find((s) => s.id === result.style)?.label || 'AI'
    return {
      project: next,
      what: `Made AI drums (${label})`,
      toast: result.provider === 'mock' ? 'Preview drums placed' : `AI drums placed · ${result.match}% on your pattern`,
    }
  }

  const track = trackById(p, info.trackId)
  if (!track) return null
  const styleLabel = partStyleLabel(result.part, result.style)
  let next = p
  let audioId = p.realParts?.[info.trackId]?.audioTrackId
  if (!audioId || !trackById(next, audioId)) {
    const t = { ...makeTrack(next, 'audio'), name: `${track.name} (real)` }
    const at = next.tracks.findIndex((x) => x.id === info.trackId) + 1
    next = { ...next, tracks: [...next.tracks.slice(0, at), t, ...next.tracks.slice(at)] }
    audioId = t.id
  }
  next = updateTrack(next, audioId, { clips: [clip], mute: false })
  next = updateTrack(next, info.trackId, { mute: true })
  const realParts = { ...(next.realParts || {}), [info.trackId]: { part: result.part, style: result.style, polish: result.polish, provider: result.provider, match: result.match, audioTrackId: audioId, signature: info.signature } }
  return {
    project: { ...next, realParts },
    what: `Made ${track.name} sound real (${styleLabel}${result.polish ? ', AI polish' : ''})`,
    toast: result.polish ? (result.provider === 'mock' ? 'Preview polish placed' : `AI polish placed · ${result.match}% of your notes kept`) : `${track.name} now plays on ${styleLabel}`,
  }
}
