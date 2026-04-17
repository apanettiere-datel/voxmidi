import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import ResultPanel from '@/components/voxmidi/ResultPanel'
import { Heading } from '@/components/catalyst/heading'
import { Text } from '@/components/catalyst/text'

const MODE_LABELS = {
  text: 'Text prompt',
  voice: 'Voice recording',
  source: 'Audio source',
  transform: 'Transform',
  transcribe: 'Transcribe',
  piano: 'Piano input',
}

function modeLabel(entry) {
  if (entry.mode === 'source') {
    if (!entry.prompt || entry.prompt === 'file_upload') return 'Uploaded audio'
    if (entry.prompt.startsWith('http')) return 'YouTube / URL'
    return entry.prompt
  }
  return MODE_LABELS[entry.mode] || entry.mode
}

export default function LibraryPage() {
  const authFetch = useAuthFetch()
  const navigate = useNavigate()
  const { jobs, removeJob } = useJobs()
  const [entries, setEntries] = useState([])
  const [viewResult, setViewResult] = useState(null)
  const [viewLoading, setViewLoading] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')
  const [toasts, setToasts] = useState([])
  const [newBadges, setNewBadges] = useState(new Set())
  const seenJobsRef = useRef(new Set())

  useEffect(() => {
    setLoading(true)
    authFetch('/api/library')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => { setEntries(data); setLoading(false) })
      .catch((err) => { setError(`Could not load library (${err})`); setLoading(false) })
  }, [authFetch])

  useEffect(() => {
    Object.values(jobs).forEach((job) => {
      if (job.status === 'complete' && !seenJobsRef.current.has(job.jobId) && job.result) {
        seenJobsRef.current.add(job.jobId)
        const toast = { jobId: job.jobId, result: job.result, ts: Date.now() }
        setToasts((prev) => [...prev, toast])
        setNewBadges((prev) => new Set([...prev, job.jobId]))
        setTimeout(() => setNewBadges((prev) => { const n = new Set(prev); n.delete(job.jobId); return n }), 60000)
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.jobId !== job.jobId)), 10000)
        authFetch('/api/library')
          .then((r) => r.ok ? r.json() : null)
          .then((data) => data && setEntries(data))
          .catch(() => {})
      }
    })
  }, [jobs, authFetch])

  async function handleView(entry) {
    setViewLoading(true)
    try {
      const res = await authFetch(`/api/library/${entry.id}`)
      if (!res.ok) throw new Error('Failed')
      const data = await res.json()
      setViewResult({ ...data, job_id: data.id })
    } catch {
      // Fall back to list data (no tracks)
      setViewResult({ ...entry, job_id: entry.id, tracks: [] })
    } finally {
      setViewLoading(false)
    }
  }

  async function handleDelete(id) {
    setDeleting(id)
    try {
      const res = await authFetch(`/api/library/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setEntries((prev) => prev.filter((e) => e.id !== id))
        if (viewResult?.job_id === id) setViewResult(null)
      }
    } catch { /* ignore */ }
    finally { setDeleting(null); setConfirmDelete(null) }
  }

  async function handleToggleFavorite(id) {
    try {
      const res = await authFetch(`/api/library/${id}/favorite`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setEntries((prev) => prev.map((e) => e.id === id ? { ...e, is_favorite: data.is_favorite } : e))
      }
    } catch { /* ignore */ }
  }

  async function handleShare(id) {
    // Mark as shared on backend, then copy URL
    authFetch(`/api/library/${id}/share`, { method: 'POST' }).catch(() => {})
    const url = `${window.location.origin}/share/${id}`
    try {
      await navigator.clipboard.writeText(url)
      alert('Share link copied!')
    } catch {
      prompt('Copy this share link:', url)
    }
  }

  function handleRemix(entry) {
    sessionStorage.setItem('voxmidi_remix', JSON.stringify({
      prompt: entry.prompt || '',
      genre: entry.genre || 'pop',
      tempo: entry.tempo || 120,
      key: entry.key || 'Am',
    }))
    navigate('/')
  }

  const displayed = filter === 'favorites' ? entries.filter((e) => e.is_favorite) : entries
  const sorted = filter === 'all'
    ? [...displayed].sort((a, b) => (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0))
    : displayed

  if (loading) {
    return (
      <div className="space-y-8">
        <Heading>Library</Heading>
        <div className="text-sm text-zinc-400">Loading...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <Heading>Library</Heading>
        <Text>Your past generations — audio, stems, and MIDI.</Text>
      </div>

      {/* Full result modal */}
      {(viewResult || viewLoading) && (
        <div className="fixed inset-0 z-50 bg-white dark:bg-zinc-950 overflow-y-auto">
          <div className="sticky top-0 z-10 bg-white dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 flex items-center gap-3">
            <button
              onClick={() => setViewResult(null)}
              className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition"
            >
              ← Back to Library
            </button>
            {viewResult && (
              <span className="text-sm text-zinc-400 dark:text-zinc-500 truncate">
                {viewResult.genre?.replace(/-/g, ' ')} · {viewResult.tempo} BPM · {viewResult.key}
              </span>
            )}
          </div>
          <div className="max-w-2xl mx-auto px-4 py-6">
            {viewLoading ? (
              <div className="text-center py-20 text-zinc-400 animate-pulse">Loading...</div>
            ) : (
              <ResultPanel result={viewResult} />
            )}
          </div>
        </div>
      )}

      {/* Completion toasts */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80">
          {toasts.map((toast) => (
            <div key={toast.jobId}
              className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/90 shadow-xl p-4 space-y-2"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">🎵 Your music is ready!</p>
                <button onClick={() => setToasts((p) => p.filter((t) => t.jobId !== toast.jobId))}
                  className="text-zinc-400 hover:text-zinc-600 text-sm">✕</button>
              </div>
              {toast.result?.audio_url && (
                <audio controls src={toast.result.audio_url} className="w-full h-8 rounded" />
              )}
              <button
                onClick={() => {
                  sessionStorage.setItem('voxmidi_pending_result', JSON.stringify(toast.result))
                  removeJob(toast.jobId)
                  setToasts((p) => p.filter((t) => t.jobId !== toast.jobId))
                  navigate('/')
                }}
                className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold py-1.5 transition"
              >
                View on Create →
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-4 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Filter tabs */}
      {entries.length > 0 && (
        <div className="flex gap-2">
          <button onClick={() => setFilter('all')}
            className={`rounded-full px-3 py-1 text-sm font-medium transition ${
              filter === 'all' ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
            }`}>
            All ({entries.length})
          </button>
          <button onClick={() => setFilter('favorites')}
            className={`rounded-full px-3 py-1 text-sm font-medium transition ${
              filter === 'favorites' ? 'bg-amber-500 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
            }`}>
            ⭐ Favorites ({entries.filter((e) => e.is_favorite).length})
          </button>
        </div>
      )}

      {sorted.length === 0 && !error ? (
        <div className="rounded-xl border-2 border-dashed border-zinc-200 dark:border-zinc-800 p-16 text-center">
          <p className="text-zinc-500 dark:text-zinc-400 text-sm">
            {filter === 'favorites' ? 'No favorites yet. Star a generation to save it here.' : 'No generations yet.'}
          </p>
          <Link to="/" className="mt-4 inline-block text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
            Go to Create →
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((entry) => (
            <div key={entry.id}
              className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden"
            >
              <div className="p-4">
                {/* Top: genre badge + tempo + key */}
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <span className="rounded-full bg-indigo-100 dark:bg-indigo-900/40 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300 capitalize">
                    {entry.genre?.replace(/-/g, ' ') || '—'}
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">{entry.tempo} BPM</span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">{entry.key}</span>
                  {newBadges.has(entry.id) && (
                    <span className="inline-flex items-center rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 text-xs font-bold text-emerald-700 dark:text-emerald-300 animate-pulse">NEW</span>
                  )}
                </div>

                {/* Prompt — 2 line clamp */}
                {entry.prompt && entry.mode !== 'source' && (
                  <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-1.5 line-clamp-2">
                    {entry.prompt}
                  </p>
                )}

                {/* Meta: date · duration · cost */}
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-3">
                  {new Date(entry.date).toLocaleDateString()} · {Math.round(entry.duration || 0)}s
                  {entry.replicate_cost > 0 && ` · $${entry.replicate_cost.toFixed(3)}`}
                </p>

                {/* Action buttons */}
                <div className="flex items-center gap-1 sm:gap-1.5">
                  {/* Favorite */}
                  <button
                    onClick={() => handleToggleFavorite(entry.id)}
                    title={entry.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
                    className="rounded-lg px-2 py-1.5 text-base transition hover:scale-110 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    {entry.is_favorite ? '⭐' : '☆'}
                  </button>

                  {/* View */}
                  <button
                    onClick={() => handleView(entry)}
                    className="flex-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition text-center"
                  >
                    <span className="hidden sm:inline">View</span>
                    <span className="sm:hidden">👁️</span>
                  </button>

                  {/* Remix */}
                  <button
                    onClick={() => handleRemix(entry)}
                    title="Remix"
                    className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                  >
                    <span className="hidden sm:inline">🔀 Remix</span>
                    <span className="sm:hidden">🔀</span>
                  </button>

                  {/* Share */}
                  <button
                    onClick={() => handleShare(entry.id)}
                    title="Share"
                    className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                  >
                    <span className="hidden sm:inline">🔗 Share</span>
                    <span className="sm:hidden">🔗</span>
                  </button>

                  {/* MIDI */}
                  {entry.midi_url && (
                    <a href={entry.midi_url} download
                      title="Download MIDI"
                      className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 transition"
                    >
                      <span className="hidden sm:inline">🎹 MIDI</span>
                      <span className="sm:hidden">🎹</span>
                    </a>
                  )}

                  {/* MP3 */}
                  {entry.audio_url && (
                    <a href={entry.audio_url} download
                      title="Download MP3"
                      className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 transition"
                    >
                      <span className="hidden sm:inline">🎵 MP3</span>
                      <span className="sm:hidden">🎵</span>
                    </a>
                  )}

                  {/* Delete */}
                  {confirmDelete === entry.id ? (
                    <div className="flex items-center gap-1">
                      <button onClick={() => handleDelete(entry.id)} disabled={deleting === entry.id}
                        className="rounded px-2 py-1 text-xs bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition">
                        {deleting === entry.id ? '...' : 'Yes'}
                      </button>
                      <button onClick={() => setConfirmDelete(null)}
                        className="rounded px-2 py-1 text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition">
                        No
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmDelete(entry.id)}
                      title="Delete"
                      className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-500 border border-red-100 dark:border-red-900/40 hover:bg-red-50 dark:hover:bg-red-950/20 transition">
                      🗑️
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
