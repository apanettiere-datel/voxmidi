import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { SparklesIcon } from '@heroicons/react/20/solid'
import { Button } from '@/components/catalyst/button'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine, performedNotes } from '@/lib/studio/engine'
import { trackById, updateTrack, totalBars, drumSignature, BEATS_PER_BAR } from '@/lib/studio/project'
import { Pill, Callout, panel } from './ui'

const STYLES = [
  { id: 'acoustic', label: 'Acoustic kit' },
  { id: 'rock', label: 'Rock room' },
  { id: 'breaks', label: 'Vintage breaks' },
  { id: 'trap', label: 'Trap 808' },
  { id: 'brushes', label: 'Brushed jazz' },
  { id: 'electronic', label: 'Drum machine' },
]

const STATUS = {
  queued: 'Waiting in queue...',
  processing: 'Starting...',
  rendering_pattern: 'Rendering your pattern...',
  generating_audio: 'Playing it on a real kit... this takes up to a minute',
  checking_timing: 'Checking it lines up with your pattern...',
}

export default function AiDrumsPanel() {
  const authFetch = useAuthFetch()
  const { jobs, startJob, removeJob } = useJobs()
  const { project, setProject, addTake, toast, refreshUsage, usage } = useStudio()
  const [style, setStyle] = useState(project.aiDrums?.style || 'acoustic')
  const [strength, setStrength] = useState(0.5)
  const [jobId, setJobId] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const job = jobId ? jobs[jobId] : null
  const ai = project.aiDrums
  const aiTrack = trackById(project, 'drumsai')
  const usingAi = !!aiTrack && !aiTrack.mute
  const stale = ai && ai.signature !== drumSignature(project)
  const drumNotes = trackById(project, 'drums')?.notes || []

  // When the job finishes, pull the audio in and put it on an AI drums track
  useEffect(() => {
    if (!job) return
    if (job.status === 'complete' && job.result) {
      const result = job.result
      removeJob(jobId)
      setJobId(null)
      place(result).catch((e) => setError(`Couldn't load the AI drums: ${e.message}`)).finally(() => setBusy(false))
    } else if (job.status === 'error' || job.status === 'cancelled') {
      setError(job.status === 'cancelled' ? 'Cancelled. Nothing was placed.' : job.error || 'The AI drums failed. Nothing was placed.')
      removeJob(jobId)
      setJobId(null)
      setBusy(false)
      refreshUsage()
    }
  }, [job?.status])

  async function place(result) {
    const res = await authFetch(result.audio_url)
    if (!res.ok) throw new Error(`download failed (${res.status})`)
    const buffer = await engine.context().decodeAudioData(await res.arrayBuffer())
    const label = STYLES.find((s) => s.id === result.style)?.label || 'AI'
    const take = await addTake(buffer, { name: `AI drums · ${label}` })
    const clip = { id: `ai${Date.now().toString(36)}`, takeId: take.id, startBeat: 0, offset: 0, duration: buffer.duration }
    setProject((p) => {
      let next = p
      if (!trackById(next, 'drumsai')) {
        const at = next.tracks.findIndex((t) => t.id === 'drums') + 1
        const track = { id: 'drumsai', name: 'AI drums', kind: 'audio', sound: 'Dry', mute: false, solo: false, vol: 85, notes: [], clips: [] }
        next = { ...next, tracks: [...next.tracks.slice(0, at), track, ...next.tracks.slice(at)] }
      }
      next = updateTrack(next, 'drumsai', { clips: [clip], mute: false })
      next = updateTrack(next, 'drums', { mute: true })
      return { ...next, aiDrums: { style: result.style, provider: result.provider, match: result.match, offsetMs: result.offset_ms, signature: drumSignature(p) } }
    }, { what: `Made AI drums (${label})` })
    refreshUsage()
    toast(result.provider === 'mock' ? 'Preview drums placed' : `AI drums placed · ${result.match}% on your pattern`)
  }

  async function start() {
    setError(null)
    setBusy(true)
    try {
      const drums = trackById(project, 'drums')
      const body = {
        tempo: project.tempo,
        total_beats: totalBars(project.sections) * BEATS_PER_BAR,
        notes: performedNotes(project, drums).map(({ p, t, d, v }) => ({ p, t: Math.max(0, t), d, v })),
        style,
        strength,
      }
      const res = await authFetch('/api/studio/drums/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(res.status === 429 ? `That's your ${usage?.limit ?? ''} songs for the month.` : err.detail || `Request failed: ${res.status}`)
      }
      const data = await res.json()
      setJobId(data.job_id)
      startJob(data.job_id, { label: `AI drums · ${STYLES.find((s) => s.id === style).label}` })
      refreshUsage()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  function hear(which) {
    setProject((p) => updateTrack(updateTrack(p, 'drumsai', { mute: which !== 'ai' }), 'drums', { mute: which === 'ai' }), { undoable: false })
  }

  return (
    <section className={clsx(panel, 'p-5 mt-4 space-y-4')}>
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-[16rem]">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Real drums with AI</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            Your pattern gets played on a real-sounding kit. The hits stay where you put them; the AI changes the sound, then we check every kick and snare still lines up.
          </p>
        </div>
        {aiTrack && (
          <div className="flex rounded-full bg-zinc-800 p-0.5 self-start">
            {[['ai', 'AI drums'], ['pattern', 'Pattern']].map(([k, label]) => (
              <button key={k} type="button" onClick={() => hear(k)}
                className={clsx('rounded-full px-3 py-1 text-xs transition', (k === 'ai') === usingAi ? 'bg-indigo-600 text-white' : 'text-zinc-400')}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {STYLES.map((s) => <Pill key={s.id} on={style === s.id} onClick={() => setStyle(s.id)}>{s.label}</Pill>)}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-zinc-500 dark:text-zinc-400 w-40">Stay close to my pattern</span>
        <input type="range" min={0.2} max={0.9} step={0.05} value={strength} onChange={(e) => setStrength(e.target.valueAsNumber)} className="flex-1 min-w-[8rem] accent-indigo-500" />
        <span className="text-xs text-zinc-500 dark:text-zinc-400 w-32 text-right">Let the AI play</span>
        <span className="font-mono tabular-nums text-xs text-zinc-400 w-10 text-right">{Math.round(strength * 100)}%</span>
      </div>

      {busy && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-zinc-900 dark:text-white animate-pulse">{STATUS[job?.status] || 'Starting...'}</p>
          <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2">
            <div className="bg-indigo-600 h-2 rounded-full transition-all duration-700" style={{ width: `${job?.progress || 5}%` }} />
          </div>
        </div>
      )}

      {error && <Callout title={error}>Your pattern is untouched.</Callout>}

      {ai && !busy && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {ai.provider === 'mock'
            ? 'Preview only: the AI drum service isn\'t set up on this server, so this is your pattern with some room on it. Nothing was counted.'
            : <>Last render: {STYLES.find((s) => s.id === ai.style)?.label} · <span className="font-mono tabular-nums">{ai.match}%</span> of kicks and snares on your pattern · <span className="font-mono tabular-nums">{ai.offsetMs} ms</span> alignment shift.</>}
          {stale && <span className="text-amber-400"> The pattern changed since then; make them again to match.</span>}
        </p>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <Button color="indigo" disabled={busy || !drumNotes.length} onClick={start}>
          <SparklesIcon data-slot="icon" />
          {aiTrack ? 'Make Real Drums Again' : 'Make Real Drums'}
        </Button>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">Counts as one song. If it doesn't line up, nothing is placed and it's not counted.</span>
      </div>
    </section>
  )
}
