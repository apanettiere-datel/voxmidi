// Shared landing step for generated band stems (BandPanel, SongBuilderPanel):
// download the result, decode it, and place it as the only clip on a track,
// creating the track when the project doesn't have it yet.
import { engine } from '@/lib/studio/engine'
import { trackById, updateTrack } from '@/lib/studio/project'

export async function placeStem({ authFetch, addTake, setProject, result, trackId, trackName }) {
  const res = await authFetch(result.audio_url)
  if (!res.ok) throw new Error(`download failed (${res.status})`)
  const buffer = await engine.context().decodeAudioData(await res.arrayBuffer())
  const take = await addTake(buffer, { name: `${trackName} stem` })
  const clip = { id: `band${Date.now().toString(36)}`, takeId: take.id, startBeat: 0, offset: 0, duration: buffer.duration }
  setProject((p) => {
    let next = p
    if (!trackById(next, trackId)) {
      const track = { id: trackId, name: trackName, kind: 'audio', sound: 'Dry', mute: false, solo: false, vol: 85, notes: [], clips: [] }
      next = { ...next, tracks: [...next.tracks, track] }
    }
    return updateTrack(next, trackId, { clips: [clip] })
  }, { what: `Added ${trackName} stem` })
}
