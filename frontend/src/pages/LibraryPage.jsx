import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
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

function AudioMiniPlayer({ src }) {
  if (!src) return null
  return (
    <audio
      controls
      src={src}
      className="w-full h-9 rounded-lg mt-2"
      style={{ minWidth: 0 }}
    />
  )
}

export default function LibraryPage() {
  const authFetch = useAuthFetch()
  const navigate = useNavigate()
  const { jobs, removeJob } = useJobs()
  const [entries, setEntries] = useState([])
  const [expanded, setExpanded] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all') // 'all' | 'favorites'
  const [toasts, setToasts] = useState([]) // [{jobId, result, ts}]
  const [newBadges, setNewBadges] = useState(new Set()) // set of entry IDs
  const seenJobsRef = useRef(new Set())

  useEffect(() => {
    setLoading(true)
    authFetch('/api/library')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => { setEntries(data); setLoading(false) })
      .catch((err) => { setError(`Could not load library (${err})`); setLoading(false) })
  }, [authFetch])

  // Watch for newly completed jobs → show toast + refresh library
  useEffect(() => {
    Object.values(jobs).forEach((job) => {
      if (job.status === 'complete' && !seenJobsRef.current.has(job.jobId) && job.result) {
        seenJobsRef.current.add(job.jobId)
        // Add toast
        const toast = { jobId: job.jobId, result: job.result, ts: Date.now() }
        setToasts((prev) => [...prev, toast])
        // Add new badge
        setNewBadges((prev) => new Set([...prev, job.jobId]))
        setTimeout(() => setNewBadges((prev) => { const n = new Set(prev); n.delete(job.jobId); return n }), 60000)
        // Auto-dismiss toast after 10s
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.jobId !== job.jobId)), 10000)
        // Refresh library to show new entry
        authFetch('/api/library')
          .then((r) => r.ok ? r.json() : null)
          .then((data) => data && setEntries(data))
          .catch(() => {})
      }
    })
  }, [jobs, authFetch])

  async function handleDelete(id) {
    setDeleting(id)
    try {
      const res = await authFetch(`/api/library/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setEntries((prev) => prev.filter((e) => e.id !== id))
        if (expanded === id) setExpanded(null)
      }
    } catch { /* ignore */ }
    finally { setDeleting(null); setConfirmDelete(null) }
  }

  async function handleToggleFavorite(id) {
    try {
      const res = await authFetch(`/api/library/${id}/favorite`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setEntries((prev) =>
          prev.map((e) => e.id === id ? { ...e, is_favorite: data.is_favorite } : e)
        )
      }
    } catch { /* ignore */ }
  }

  async function handleShare(id) {
    const url = `${window.location.origin}/share/${id}`
    try {
      await navigator.clipboard.writeText(url)
      alert('Share link copied: ' + url)
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

  const displayed = filter === 'favorites'
    ? entries.filter((e) => e.is_favorite)
    : entries

  // Sort favorites to top within "all" view
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

      {/* Job completion toasts */}
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
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    sessionStorage.setItem('voxmidi_pending_result', JSON.stringify(toast.result))
                    removeJob(toast.jobId)
                    setToasts((p) => p.filter((t) => t.jobId !== toast.jobId))
                    navigate('/')
                  }}
                  className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold py-1.5 transition"
                >
                  View on Create →
                </button>
              </div>
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
          <button
            onClick={() => setFilter('all')}
            className={`rounded-full px-3 py-1 text-sm font-medium transition ${
              filter === 'all'
                ? 'bg-indigo-600 text-white'
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
            }`}
          >
            All ({entries.length})
          </button>
          <button
            onClick={() => setFilter('favorites')}
            className={`rounded-full px-3 py-1 text-sm font-medium transition ${
              filter === 'favorites'
                ? 'bg-amber-500 text-white'
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
            }`}
          >
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
            <div
              key={entry.id}
              className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden"
            >
              {/* Header row */}
              <div className="flex items-start gap-3 p-4">
                <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-white text-xs font-bold">
                    {(entry.genre || 'MI').slice(0, 2).toUpperCase()}
                  </span>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-zinc-900 dark:text-white capitalize">
                      {entry.genre?.replace(/-/g, ' ') || '—'} · {entry.tempo} BPM · {entry.key}
                    </p>
                    {newBadges.has(entry.id) && (
                      <span className="inline-flex items-center rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 text-xs font-bold text-emerald-700 dark:text-emerald-300 animate-pulse">
                        NEW
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    {modeLabel(entry)} · {entry.tracks_count} tracks ·{' '}
                    {Math.round(entry.duration || 0)}s · {new Date(entry.date).toLocaleDateString()}
                    {entry.replicate_cost > 0 && ` · $${entry.replicate_cost.toFixed(3)}`}
                  </p>
                  {entry.prompt && entry.mode !== 'source' && (
                    <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5 truncate italic">
                      "{entry.prompt}"
                    </p>
                  )}

                  {/* Action buttons — wrap on mobile */}
                  <div className="flex items-center gap-1.5 flex-wrap mt-2">
                    {/* Favorite */}
                    <button
                      onClick={() => handleToggleFavorite(entry.id)}
                      title={entry.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
                      className="rounded-lg px-2 py-1 text-sm transition hover:scale-110"
                    >
                      {entry.is_favorite ? '⭐' : '☆'}
                    </button>

                    {/* Expand */}
                    <button
                      onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                      className="rounded-lg px-2.5 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                    >
                      {expanded === entry.id ? 'Close' : 'View'}
                    </button>

                    {/* Remix */}
                    <button
                      onClick={() => handleRemix(entry)}
                      title="Remix"
                      className="rounded-lg px-2.5 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                    >
                      🔀
                    </button>

                    {/* Share */}
                    <button
                      onClick={() => handleShare(entry.id)}
                      className="rounded-lg px-2.5 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                    >
                      🔗
                    </button>

                    {/* MIDI download */}
                    {entry.midi_url && (
                      <a
                        href={entry.midi_url}
                        download
                        className="rounded-lg px-2.5 py-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 transition"
                      >
                        🎹 MIDI
                      </a>
                    )}

                    {/* Audio download */}
                    {entry.audio_url && (
                      <a
                        href={entry.audio_url}
                        download
                        className="rounded-lg px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 transition"
                      >
                        🎵 MP3
                      </a>
                    )}

                    {/* Delete */}
                    {confirmDelete === entry.id ? (
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-red-600 dark:text-red-400">Delete?</span>
                        <button
                          onClick={() => handleDelete(entry.id)}
                          disabled={deleting === entry.id}
                          className="rounded px-2 py-0.5 text-xs bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition"
                        >
                          {deleting === entry.id ? '...' : 'Yes'}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="rounded px-2 py-0.5 text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(entry.id)}
                        className="rounded-lg px-2.5 py-1 text-xs font-medium text-red-500 border border-red-100 dark:border-red-900/40 hover:bg-red-50 dark:hover:bg-red-950/20 transition"
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Expanded detail view */}
              {expanded === entry.id && (
                <div className="border-t border-zinc-100 dark:border-zinc-800 p-4 bg-zinc-50 dark:bg-zinc-900/50 space-y-4 overflow-x-hidden">
                  {/* Stats grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div><span className="text-zinc-400">Genre</span><br /><span className="font-medium text-zinc-700 dark:text-zinc-300 capitalize">{entry.genre?.replace(/-/g, ' ')}</span></div>
                    <div><span className="text-zinc-400">Tempo</span><br /><span className="font-medium text-zinc-700 dark:text-zinc-300">{entry.tempo} BPM</span></div>
                    <div><span className="text-zinc-400">Key</span><br /><span className="font-medium text-zinc-700 dark:text-zinc-300">{entry.key}</span></div>
                    <div><span className="text-zinc-400">Duration</span><br /><span className="font-medium text-zinc-700 dark:text-zinc-300">{Math.round(entry.duration || 0)}s</span></div>
                  </div>

                  {/* Full mix player */}
                  {entry.audio_url && (
                    <div>
                      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">🎵 Full Mix</p>
                      <AudioMiniPlayer src={entry.audio_url} />
                    </div>
                  )}

                  {/* Stem players */}
                  {entry.stems && Object.keys(entry.stems).length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Stems</p>
                      {Object.entries(entry.stems).map(([stem, url]) => (
                        <div key={stem} className="flex items-center gap-2 min-w-0">
                          <span className="text-xs text-zinc-500 w-12 shrink-0 capitalize">{stem}</span>
                          <div className="flex-1 min-w-0"><AudioMiniPlayer src={url} /></div>
                          <a
                            href={url}
                            download={`${stem}.mp3`}
                            className="shrink-0 text-xs text-zinc-400 hover:text-indigo-500 transition"
                          >↓</a>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Stems zip */}
                  {entry.stems && Object.keys(entry.stems).length > 0 && (
                    <a
                      href={`/api/download/${entry.id}/stems.zip`}
                      download
                      className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs border border-zinc-800 dark:border-zinc-600 bg-zinc-800 dark:bg-zinc-700 text-white hover:bg-zinc-700 dark:hover:bg-zinc-600 transition"
                    >
                      📦 All stems + README .zip
                    </a>
                  )}

                  {/* Actions */}
                  <div className="flex gap-3 text-sm flex-wrap">
                    <button
                      onClick={() => handleRemix(entry)}
                      className="text-indigo-600 dark:text-indigo-400 hover:underline text-xs"
                    >
                      🔀 Remix →
                    </button>
                    <a
                      href={`/share/${entry.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-zinc-500 dark:text-zinc-400 hover:underline text-xs"
                    >
                      Share link →
                    </a>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
