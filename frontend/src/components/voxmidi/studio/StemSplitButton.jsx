import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { RectangleStackIcon } from '@heroicons/react/20/solid'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { wavBytes } from '@/lib/studio/files'
import { trackById, updateTrack } from '@/lib/studio/project'

const STEM_LABELS = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other' }

// Toolbar button: split the selected audio clip's take into four stems on the
// local GPU (Demucs), landing each as a stem_{name} audio track whose clip
// copies the source clip's position, so the stems play exactly where the
// original did.
export default function StemSplitButton({ sc, className }) {
  const authFetch = useAuthFetch()
  const { jobs, startJob, removeJob } = useJobs()
  const { setProject, addTake, toast } = useStudio()
  const [jobId, setJobId] = useState(null)
  const [srcClip, setSrcClip] = useState(null) // geometry of the clip being split
  const job = jobId ? jobs[jobId] : null

  useEffect(() => {
    if (!job) return
    if (job.status === 'complete' && job.result) {
      const { result } = job
      removeJob(jobId)
      setJobId(null)
      place(result, srcClip).catch((e) => toast(`Couldn't load the stems: ${e.message}`))
    } else if (job.status === 'error' || job.status === 'cancelled') {
      toast(job.status === 'cancelled' ? 'Stem split cancelled' : job.error || 'The stem split failed. Your tracks are untouched.')
      removeJob(jobId)
      setJobId(null)
    }
  }, [job?.status])

  async function place(result, src) {
    const placed = []
    for (const [name, url] of Object.entries(result.stems)) {
      const res = await authFetch(url)
      if (!res.ok) throw new Error(`download failed (${res.status})`)
      const buffer = await engine.context().decodeAudioData(await res.arrayBuffer())
      const label = STEM_LABELS[name] || name
      const take = await addTake(buffer, { name: `${label} stem` })
      placed.push({ name, label, takeId: take.id })
    }
    setProject((p) => {
      let next = p
      for (const { name, label, takeId } of placed) {
        const trackId = `stem_${name}`
        if (!trackById(next, trackId)) {
          next = { ...next, tracks: [...next.tracks, { id: trackId, name: `${label} stem`, kind: 'audio', sound: 'Dry', mute: false, solo: false, vol: 80, notes: [], clips: [] }] }
        }
        const clip = { id: `stem${Date.now().toString(36)}${name}`, takeId, startBeat: src.startBeat, offset: src.offset, duration: src.duration }
        next = updateTrack(next, trackId, { clips: [clip] })
      }
      return next
    }, { what: 'Split a recording into stems' })
    toast(result.provider === 'mock' ? 'Placeholder stems placed (no GPU configured)' : 'Split into four stems')
  }

  const canSplit = !!(sc && sc.track.kind === 'audio' && sc.clip.takeId && engine.takes.has(sc.clip.takeId))

  async function split() {
    if (!canSplit || jobId) return
    try {
      const bytes = wavBytes(engine.takes.get(sc.clip.takeId))
      const form = new FormData()
      form.append('take', new Blob([bytes], { type: 'audio/wav' }), 'take.wav')
      const res = await authFetch('/api/studio/stems', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `Request failed: ${res.status}`)
      }
      const data = await res.json()
      setSrcClip({ startBeat: sc.clip.startBeat, offset: sc.clip.offset, duration: sc.clip.duration })
      setJobId(data.job_id)
      startJob(data.job_id, { label: 'Stem split' })
    } catch (e) {
      toast(e.message)
    }
  }

  return (
    <button
      type="button"
      className={clsx(className, 'text-accent-text')}
      onClick={split}
      disabled={!canSplit || !!jobId}
      title="Split the selected recording into vocals, drums, bass and other on the local GPU, free"
    >
      <RectangleStackIcon className="size-3.5" />
      {jobId ? 'Splitting...' : 'Split into stems'}
    </button>
  )
}
