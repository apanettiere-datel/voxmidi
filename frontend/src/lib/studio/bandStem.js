// Shared landing step for generated stems (BandPanel, SongBuilderPanel,
// GeneratePartPanel): download the result, decode it, and place it as the only
// clip on an audio track, creating the track when it doesn't exist yet.
// `extra` is merged into the track (e.g. an AI marker); `afterTrackId` positions
// a newly created track right after that track instead of at the end.
import { engine } from '@/lib/studio/engine'
import { trackById, updateTrack } from '@/lib/studio/project'

export async function placeStem({ authFetch, addTake, setProject, result, trackId, trackName, extra = {}, afterTrackId = null }) {
  const res = await authFetch(result.audio_url)
  if (!res.ok) throw new Error(`download failed (${res.status})`)
  const buffer = await engine.context().decodeAudioData(await res.arrayBuffer())
  const take = await addTake(buffer, { name: `${trackName} stem` })
  const clip = { id: `ai${Date.now().toString(36)}`, takeId: take.id, startBeat: 0, offset: 0, duration: buffer.duration }
  setProject((p) => {
    let next = p
    if (!trackById(next, trackId)) {
      const track = { id: trackId, name: trackName, kind: 'audio', sound: 'Dry', mute: false, solo: false, vol: 85, notes: [], clips: [], ...extra }
      const at = afterTrackId ? next.tracks.findIndex((t) => t.id === afterTrackId) + 1 : next.tracks.length
      next = { ...next, tracks: [...next.tracks.slice(0, at), track, ...next.tracks.slice(at)] }
    }
    return updateTrack(next, trackId, { clips: [clip], ...extra })
  }, { what: `Added ${trackName}` })
}
