import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuthFetch } from '@/lib/authFetch'
import { Heading } from '@/components/catalyst/heading'
import { Text } from '@/components/catalyst/text'

const MODES = { text: 'Text', voice: 'Voice', source: 'Source', transform: 'Transform', transcribe: 'Transcribe' }

export default function LibraryPage() {
  const authFetch = useAuthFetch()
  const [entries, setEntries] = useState([])
  const [expanded, setExpanded] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    authFetch('/api/library')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => { setEntries(data); setLoading(false) })
      .catch((err) => { setError(`Could not load library (${err})`); setLoading(false) })
  }, [authFetch])

  async function handleDelete(id) {
    setDeleting(id)
    try {
      const res = await authFetch(`/api/library/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setEntries((prev) => prev.filter((e) => e.id !== id))
        if (expanded === id) setExpanded(null)
      }
    } catch {
      /* ignore */
    } finally {
      setDeleting(null)
      setConfirmDelete(null)
    }
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

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-4 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {entries.length === 0 && !error ? (
        <div className="rounded-xl border-2 border-dashed border-zinc-200 dark:border-zinc-800 p-16 text-center">
          <p className="text-zinc-500 dark:text-zinc-400 text-sm">No generations yet.</p>
          <Link to="/" className="mt-4 inline-block text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
            Go to Create →
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden"
            >
              {/* Header row */}
              <div className="flex items-center gap-4 p-4">
                <div className="h-10 w-10 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
                  <span className="text-white text-xs font-bold">
                    {(entry.genre || 'MI').slice(0, 2).toUpperCase()}
                  </span>
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-white capitalize">
                    {entry.genre?.replace(/-/g, ' ') || '—'} · {entry.tempo} BPM · {entry.key}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    {MODES[entry.mode] || entry.mode} · {entry.tracks_count} tracks ·{' '}
                    {Math.round(entry.duration || 0)}s · {new Date(entry.date).toLocaleDateString()}
                    {entry.replicate_cost > 0 && ` · $${entry.replicate_cost.toFixed(3)}`}
                  </p>
                  {entry.prompt && (
                    <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5 truncate max-w-sm italic">
                      "{entry.prompt}"
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                  <button
                    onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                  >
                    {expanded === entry.id ? 'Close' : 'View'}
                  </button>
                  <button
                    onClick={() => handleShare(entry.id)}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                  >
                    🔗
                  </button>
                  {entry.midi_url && (
                    <a
                      href={entry.midi_url}
                      download
                      className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 transition"
                    >
                      🎹 MIDI
                    </a>
                  )}
                  {entry.audio_url && (
                    <a
                      href={entry.audio_url}
                      download
                      className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 transition"
                    >
                      🎵 MP3
                    </a>
                  )}
                  {confirmDelete === entry.id ? (
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-red-600 dark:text-red-400">Delete?</span>
                      <button
                        onClick={() => handleDelete(entry.id)}
                        disabled={deleting === entry.id}
                        className="rounded px-2 py-1 text-xs bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition"
                      >
                        {deleting === entry.id ? '...' : 'Yes'}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="rounded px-2 py-1 text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(entry.id)}
                      className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-500 border border-red-100 dark:border-red-900/40 hover:bg-red-50 dark:hover:bg-red-950/20 transition"
                    >
                      🗑️
                    </button>
                  )}
                </div>
              </div>

              {/* Expanded view */}
              {expanded === entry.id && (
                <div className="border-t border-zinc-100 dark:border-zinc-800 p-4 bg-zinc-50 dark:bg-zinc-900/50 space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div><span className="text-zinc-400">Genre</span><br /><span className="font-medium text-zinc-700 dark:text-zinc-300 capitalize">{entry.genre?.replace(/-/g, ' ')}</span></div>
                    <div><span className="text-zinc-400">Tempo</span><br /><span className="font-medium text-zinc-700 dark:text-zinc-300">{entry.tempo} BPM</span></div>
                    <div><span className="text-zinc-400">Key</span><br /><span className="font-medium text-zinc-700 dark:text-zinc-300">{entry.key}</span></div>
                    <div><span className="text-zinc-400">Duration</span><br /><span className="font-medium text-zinc-700 dark:text-zinc-300">{Math.round(entry.duration || 0)}s</span></div>
                  </div>

                  {/* Audio preview */}
                  {entry.audio_url && (
                    <audio controls src={entry.audio_url} className="w-full h-10 rounded-lg" />
                  )}

                  {/* Stem links */}
                  {entry.stems && Object.keys(entry.stems).length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(entry.stems).map(([stem, url]) => (
                        <a
                          key={stem}
                          href={url}
                          download={`${stem}.mp3`}
                          className="rounded px-2 py-1 text-xs border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 transition capitalize"
                        >
                          ↓ {stem}
                        </a>
                      ))}
                      <a
                        href={`/api/download/${entry.id}/stems.zip`}
                        download
                        className="rounded px-2 py-1 text-xs border border-zinc-800 dark:border-zinc-600 bg-zinc-800 dark:bg-zinc-700 text-white hover:bg-zinc-700 dark:hover:bg-zinc-600 transition"
                      >
                        📦 All stems .zip
                      </a>
                    </div>
                  )}

                  <div className="flex gap-3 text-sm">
                    <Link
                      to="/"
                      className="text-indigo-600 dark:text-indigo-400 hover:underline text-xs"
                    >
                      Re-generate similar →
                    </Link>
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
