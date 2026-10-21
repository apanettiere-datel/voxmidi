import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { SparklesIcon } from '@heroicons/react/20/solid'
import { Button } from '@/components/catalyst/button'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import { useStudio } from '@/lib/studio/StudioContext'
import { trackById, updateTrack, roleOf } from '@/lib/studio/project'
import { placeStem } from '@/lib/studio/bandStem'
import SoundLibraryBrowser from './SoundLibraryBrowser'
import { Callout } from './ui'

const LENGTHS = [['4s', 4000], ['8s', 8000], ['15s', 15000], ['30s', 30000]]
const STATUS = { queued: 'Waiting in queue...', processing: 'Starting...', generating_part: 'Generating the part...', decoding_audio: 'Loading audio...' }

// The part of the library to browse for this track's role (bass/guitar/keys/lead).
const LIB_PART = { bass: 'bass', drums: 'guitar', chords: 'keys', melody: 'lead' }

// "Generate this part with AI": describe the sound (or pick a style from the
// library), generate an audio stem, and optionally condition it on an AI part
// already made on another track so it fits.
export default function GeneratePartPanel({ trackId }) {
  const authFetch = useAuthFetch()
  const { jobs, startJob, removeJob } = useJobs()
  const { project, setProject, addTake, toast } = useStudio()
  const track = trackById(project, trackId)
  const [prompt, setPrompt] = useState('')
  const [lengthMs, setLengthMs] = useState(8000)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [fitTo, setFitTo] = useState('')
  const [jobId, setJobId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Other tracks that already carry an AI part we could condition on.
  const refs = project.tracks.filter((t) => t.id !== trackId && t.aiSongId)
  const libPart = LIB_PART[roleOf(track)] || 'lead'
  const job = jobId ? jobs[jobId] : null

  useEffect(() => {
    if (!job) return
    if (job.status === 'complete' && job.result) {
      const result = job.result
      removeJob(jobId); setJobId(null)
      placeStem({ authFetch, addTake, setProject, result, trackId, trackName: track.name })
        .then(() => setProject((p) => updateTrack(p, trackId, { aiSongId: result.song_id, aiPrompt: result.prompt }), { undoable: false }))
        .then(() => toast(result.provider === 'mock' ? 'Placeholder part placed (no music key)' : 'AI part placed'))
        .catch((e) => setError(`Couldn't load the part: ${e.message}`))
        .finally(() => setBusy(false))
    } else if (job.status === 'error' || job.status === 'cancelled') {
      setError(job.status === 'cancelled' ? 'Cancelled.' : job.error || 'Generation failed.')
      removeJob(jobId); setJobId(null); setBusy(false)
    }
  }, [job?.status])

  async function generate() {
    setError(null); setBusy(true)
    try {
      const refTrack = refs.find((t) => t.id === fitTo)
      const body = { prompt: prompt.trim(), length_ms: lengthMs }
      if (refTrack?.aiSongId) body.ref_song_id = refTrack.aiSongId
      const res = await authFetch('/api/studio/parts/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `Request failed: ${res.status}`)
      }
      const data = await res.json()
      setJobId(data.job_id)
      startJob(data.job_id, { label: `${track.name} AI part` })
    } catch (e) {
      setError(e.message); setBusy(false)
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setBrowseOpen((v) => !v)}
          className={clsx('rounded-lg border px-2.5 py-1.5 text-xs transition whitespace-nowrap', browseOpen ? 'border-accent-strong bg-accent-surface text-accent-text' : 'border-line-strong bg-panel text-body')}
        >
          Sound library
        </button>
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={400}
          placeholder={`Describe the ${track.name.toLowerCase()}: deep EDM reese bass, 128 BPM...`}
          className="flex-1 min-w-[12rem] rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-xs text-primary placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      {browseOpen && <SoundLibraryBrowser part={libPart} current={prompt} onPick={(v) => setPrompt(v)} />}

      <div className="flex items-center gap-3 flex-wrap text-xs">
        <div className="flex rounded-full bg-raised p-0.5">
          {LENGTHS.map(([label, ms]) => (
            <button key={ms} type="button" onClick={() => setLengthMs(ms)}
              className={clsx('rounded-full px-2.5 py-0.5 transition', lengthMs === ms ? 'bg-accent-strong text-white' : 'text-faint hover:text-body')}>{label}</button>
          ))}
        </div>
        {refs.length > 0 && (
          <label className="flex items-center gap-1.5 text-muted">
            Fit to
            <select value={fitTo} onChange={(e) => setFitTo(e.target.value)}
              className="rounded-md border border-line-strong bg-panel px-1.5 py-1 text-xs text-primary focus:outline-none">
              <option value="">nothing</option>
              {refs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {busy && (
        <div className="space-y-1.5">
          <p className="text-xs text-primary animate-pulse">{STATUS[job?.status] || 'Starting...'}</p>
          <div className="w-full bg-raised rounded-full h-1.5"><div className="bg-accent-strong h-1.5 rounded-full transition-all duration-700" style={{ width: `${job?.progress || 5}%` }} /></div>
        </div>
      )}
      {error && <Callout title={error}>Your track is untouched.</Callout>}

      <div className="flex items-center gap-3 flex-wrap">
        <Button color="indigo" disabled={busy || prompt.trim().length < 3} onClick={generate}>
          <SparklesIcon data-slot="icon" />
          {busy ? 'Generating...' : 'Generate part'}
        </Button>
        <span className="text-xs text-faint">
          Writes an AI audio part onto this track. Pick "Fit to" to build it around a part you already made.
        </span>
      </div>
    </div>
  )
}
