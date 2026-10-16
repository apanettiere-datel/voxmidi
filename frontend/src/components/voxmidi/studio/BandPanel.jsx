import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { SparklesIcon } from '@heroicons/react/20/solid'
import { Button } from '@/components/catalyst/button'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine, renderMix } from '@/lib/studio/engine'
import { wavBytes } from '@/lib/studio/files'
import { trackById, updateTrack } from '@/lib/studio/project'
import { Pill, Callout, panel } from './ui'

const PART_LABELS = {
  vocals:        'Vocals',
  backing_vocals: 'Backing vocals',
  drums:         'Drums',
  bass:          'Bass',
  guitar:        'Guitar',
  keyboard:      'Keyboard',
  percussion:    'Percussion',
  strings:       'Strings',
  synth:         'Synth',
  fx:            'FX',
  brass:         'Brass',
  woodwinds:     'Woodwinds',
}

const STATUS = {
  queued:          'Waiting in queue...',
  processing:      'Starting...',
  generating_stem: 'Generating the stem on the local GPU...',
  decoding_audio:  'Decoding audio...',
}

export default function BandPanel() {
  const authFetch = useAuthFetch()
  const { jobs, startJob, removeJob } = useJobs()
  const { project, setProject, addTake, toast } = useStudio()
  const [part, setPart] = useState('guitar')
  const [style, setStyle] = useState('')
  const [jobId, setJobId] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const job = jobId ? jobs[jobId] : null

  useEffect(() => {
    if (!job) return
    if (job.status === 'complete' && job.result) {
      const result = job.result
      removeJob(jobId)
      setJobId(null)
      place(result).catch((e) => setError(`Couldn't load the stem: ${e.message}`)).finally(() => setBusy(false))
    } else if (job.status === 'error' || job.status === 'cancelled') {
      setError(job.status === 'cancelled' ? 'Cancelled. Nothing was placed.' : job.error || 'The stem generation failed. Nothing was placed.')
      removeJob(jobId)
      setJobId(null)
      setBusy(false)
    }
  }, [job?.status])

  async function place(result) {
    const res = await authFetch(result.audio_url)
    if (!res.ok) throw new Error(`download failed (${res.status})`)
    const buffer = await engine.context().decodeAudioData(await res.arrayBuffer())
    const label = PART_LABELS[result.part] || result.part
    const take = await addTake(buffer, { name: `${label} stem` })
    const trackId = `band_${result.part}`
    const clip = { id: `band${Date.now().toString(36)}`, takeId: take.id, startBeat: 0, offset: 0, duration: buffer.duration }
    setProject((p) => {
      let next = p
      if (!trackById(next, trackId)) {
        const track = { id: trackId, name: label, kind: 'audio', sound: 'Dry', mute: false, solo: false, vol: 85, notes: [], clips: [] }
        next = { ...next, tracks: [...next.tracks, track] }
      }
      next = updateTrack(next, trackId, { clips: [clip] })
      return next
    }, { what: `Added ${label} band stem` })
    toast(result.provider === 'mock' ? `${label} placeholder placed (no GPU configured)` : `${label} stem placed`)
  }

  async function generate() {
    setError(null)
    setBusy(true)
    try {
      const rendered = await renderMix(project, engine.takes)
      const bytes = wavBytes(rendered)
      const form = new FormData()
      form.append('mix', new Blob([bytes], { type: 'audio/wav' }), 'mix.wav')
      form.append('part', part)
      if (style.trim()) form.append('style', style.trim().slice(0, 300))
      const res = await authFetch('/api/studio/parts/band', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `Request failed: ${res.status}`)
      }
      const data = await res.json()
      setJobId(data.job_id)
      startJob(data.job_id, { label: `${PART_LABELS[part]} stem` })
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <section className={clsx(panel, 'p-5 mt-4 space-y-4')}>
      <div>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Add a band member</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
          Renders your current mix and asks the local GPU to generate one new instrument stem that fits it.
          Each run adds one player to the song.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {Object.entries(PART_LABELS).map(([id, label]) => (
          <Pill key={id} on={part === id} onClick={() => setPart(id)}>{label}</Pill>
        ))}
      </div>

      <input
        type="text"
        value={style}
        onChange={(e) => setStyle(e.target.value)}
        maxLength={300}
        placeholder="Style words (optional): clean electric, warm fingerpicked, bright staccato..."
        className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />

      {busy && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-zinc-900 dark:text-white animate-pulse">{STATUS[job?.status] || 'Rendering mix...'}</p>
          <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2">
            <div className="bg-indigo-600 h-2 rounded-full transition-all duration-700" style={{ width: `${job?.progress || 5}%` }} />
          </div>
        </div>
      )}

      {error && <Callout title={error}>Your tracks are untouched.</Callout>}

      <div className="flex items-center gap-3 flex-wrap">
        <Button color="indigo" disabled={busy} onClick={generate}>
          <SparklesIcon data-slot="icon" />
          Add {PART_LABELS[part]}
        </Button>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">Runs on the local GPU. Always free, never counted against your song limit.</span>
      </div>
    </section>
  )
}
