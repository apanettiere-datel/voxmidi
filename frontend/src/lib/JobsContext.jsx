/**
 * Global job tracking context.
 * Persists across page navigation so users can browse Library while generating.
 */
import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react'
import { getJobStatus } from '@/lib/api'
import { useAuthFetch } from '@/lib/authFetch'

const JobsContext = createContext(null)

export function useJobs() {
  return useContext(JobsContext) || { jobs: {}, startJob: () => {}, removeJob: () => {}, cancelJob: () => {} }
}

const STATUS_LABELS = {
  queued:           'Waiting in queue...',
  processing:       'Starting...',
  generating_audio: 'Generating audio...',
  downloading:      'Downloading...',
  separating_stems: 'Separating stems...',
  transcribing:     'Creating MIDI...',
  complete:         'Done!',
  error:            'Failed',
  cancelled:        'Cancelled',
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function JobsProvider({ children }) {
  const [jobs, setJobs] = useState({})
  const authFetch = useAuthFetch()

  const startJob = useCallback((jobId, meta = {}) => {
    setJobs(prev => ({
      ...prev,
      [jobId]: {
        jobId,
        label:     meta.label || 'Generating music...',
        kind:      meta.kind,
        genre:     meta.genre,
        tempo:     meta.tempo,
        key:       meta.key,
        status:    'processing',
        progress:  0,
        startTime: Date.now(),
        result:    null,
        error:     null,
      },
    }))
  }, [])

  const removeJob = useCallback((jobId) => {
    setJobs(prev => {
      const next = { ...prev }
      delete next[jobId]
      return next
    })
  }, [])

  const cancelJob = useCallback(async (jobId) => {
    try {
      await authFetch(`/api/cancel/${jobId}`, { method: 'POST' })
    } catch {}
    setJobs(prev => !prev[jobId] ? prev : {
      ...prev,
      [jobId]: { ...prev[jobId], status: 'cancelled' },
    })
  }, [authFetch])

  // Poll active jobs every 3 s
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs

  useEffect(() => {
    const active = Object.values(jobs).filter(
      j => !['complete', 'error', 'cancelled'].includes(j.status)
    )
    if (!active.length) return

    const timer = setInterval(async () => {
      for (const job of active) {
        try {
          const s = await getJobStatus(job.jobId, authFetch) ?? { status: 'error', message: 'This job was lost, most likely because the server restarted. Nothing was placed; please try again.' }
          setJobs(prev => {
            if (!prev[job.jobId]) return prev
            return {
              ...prev,
              [job.jobId]: {
                ...prev[job.jobId],
                status:   s.status,
                progress: s.progress ?? prev[job.jobId].progress,
                result:   s.result   || prev[job.jobId].result,
                error:    s.message  || null,
              },
            }
          })
        } catch {}
      }
    }, 3000)

    return () => clearInterval(timer)
  }, [jobs, authFetch])

  return (
    <JobsContext.Provider value={{ jobs, startJob, removeJob, cancelJob }}>
      {children}
    </JobsContext.Provider>
  )
}

// ─── Elapsed timer ────────────────────────────────────────────────────────────

function Elapsed({ startTime }) {
  const [secs, setSecs] = useState(Math.floor((Date.now() - startTime) / 1000))
  useEffect(() => {
    const t = setInterval(() => setSecs(Math.floor((Date.now() - startTime) / 1000)), 1000)
    return () => clearInterval(t)
  }, [startTime])
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return <span className="tabular-nums">{m}:{String(s).padStart(2, '0')}</span>
}

// ─── Notification bar ─────────────────────────────────────────────────────────

export function JobsNotificationBar({ activeJobId }) {
  const { jobs, removeJob, cancelJob } = useJobs()

  // Only show jobs that the current page isn't already showing inline
  const visible = Object.values(jobs).filter(j => j.jobId !== activeJobId)
  if (!visible.length) return null

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 flex flex-col gap-1.5 p-3 pointer-events-none">
      {visible.map(job => {
        const isDone      = job.status === 'complete'
        const isFailed    = job.status === 'error'
        const isCancelled = job.status === 'cancelled'
        const isActive    = !isDone && !isFailed && !isCancelled

        return (
          <div
            key={job.jobId}
            className={`pointer-events-auto mx-auto w-full max-w-lg rounded-xl border shadow-xl px-4 py-3 flex items-center gap-3 ${
              isDone      ? 'bg-emerald-50 dark:bg-emerald-950/90 border-emerald-200 dark:border-emerald-800'
            : isFailed    ? 'bg-red-50 dark:bg-red-950/90 border-red-200 dark:border-red-800'
            : isCancelled ? 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700'
            :               'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700'
            }`}
          >
            {/* Icon */}
            <span className={`text-xl flex-shrink-0 ${isActive ? 'animate-pulse' : ''}`}>
              {isDone ? '✅' : isFailed ? '⚠️' : isCancelled ? '🚫' : '🎵'}
            </span>

            {/* Text + progress */}
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium truncate ${
                isDone      ? 'text-emerald-800 dark:text-emerald-200'
              : isFailed    ? 'text-red-700 dark:text-red-300'
              : isCancelled ? 'text-zinc-500 dark:text-zinc-400'
              :               'text-zinc-900 dark:text-white'
              }`}>
                {isDone      ? '🎵 Your music is ready!'
               : isFailed    ? (job.error || 'Generation failed')
               : isCancelled ? 'Generation cancelled'
               :               (STATUS_LABELS[job.status] || 'Generating music...')}
              </p>
              <div className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
                {job.genre && (
                  <span className="capitalize">{job.genre}{job.tempo ? ` · ${job.tempo} BPM` : ''}</span>
                )}
                {isActive && <Elapsed startTime={job.startTime} />}
              </div>
              {isActive && (
                <div className="mt-1.5 w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-1">
                  <div
                    className="bg-indigo-600 h-1 rounded-full transition-all duration-700"
                    style={{ width: `${job.progress || 0}%` }}
                  />
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 flex-shrink-0">
              {isDone && job.result && job.kind !== 'studio' && (
                <button
                  onClick={() => {
                    sessionStorage.setItem('voxmidi_pending_result', JSON.stringify(job.result))
                    removeJob(job.jobId)
                    window.location.href = '/generate'
                  }}
                  className="rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 text-xs font-semibold transition"
                >
                  View →
                </button>
              )}
              <button
                onClick={() => isActive ? cancelJob(job.jobId) : removeJob(job.jobId)}
                title={isActive ? 'Cancel' : 'Dismiss'}
                className="rounded-lg p-1.5 text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition"
              >
                ✕
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
