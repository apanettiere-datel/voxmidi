import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { downloadMidiClientSide } from '@/lib/api'
import { useAuthFetch } from '@/lib/authFetch'
import PianoRoll from '@/components/voxmidi/PianoRoll'
import { Heading } from '@/components/catalyst/heading'
import { Text } from '@/components/catalyst/text'
import { Button } from '@/components/catalyst/button'
import { Divider } from '@/components/catalyst/divider'

const MODES = { text: 'Text', voice: 'Voice', source: 'Source', transform: 'Transform', transcribe: 'Transcribe' }

export default function LibraryPage() {
  const authFetch = useAuthFetch()
  const [entries, setEntries] = useState([])
  const [expanded, setExpanded] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    authFetch('/api/library')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => { setEntries(data); setLoading(false) })
      .catch(err => { setError(`Could not load library (${err})`); setLoading(false) })
  }, [authFetch])

  function handleDownload(entry) {
    if (entry.midi_url) {
      const a = document.createElement('a')
      a.href = entry.midi_url
      a.download = `voxmidi-${entry.id}.mid`
      a.click()
    }
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <Heading>Library</Heading>
        <div className="text-sm text-zinc-400 dark:text-zinc-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div>
        <Heading>Library</Heading>
        <Text>Your past MIDI generations. Click any row to view the piano roll.</Text>
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
          {entries.map(entry => (
            <div key={entry.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
              {/* Header row */}
              <div className="flex items-center gap-4 p-4">
                <div className="h-10 w-10 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
                  <span className="text-white text-xs font-bold">{(entry.genre || 'MI').slice(0, 2).toUpperCase()}</span>
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-white capitalize">
                    {(MODES[entry.mode] || entry.mode)} · {entry.genre?.replace(/-/g, ' ') || '—'} · {entry.tempo} BPM · {entry.key}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    {entry.tracks_count} tracks · {Math.round(entry.duration || 0)}s · {new Date(entry.date).toLocaleDateString()}
                    {entry.replicate_cost > 0 && ` · $${entry.replicate_cost.toFixed(3)} Replicate`}
                  </p>
                  {entry.prompt && (
                    <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5 truncate max-w-xs">{entry.prompt}</p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Button plain onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}>
                    {expanded === entry.id ? 'Close' : 'View'}
                  </Button>
                  {entry.midi_url && (
                    <Button plain onClick={() => handleDownload(entry)}>Download</Button>
                  )}
                </div>
              </div>

              {/* Piano roll (expanded) — note data not available server-side, show placeholder */}
              {expanded === entry.id && (
                <div className="border-t border-zinc-100 dark:border-zinc-800 p-4 bg-zinc-50 dark:bg-zinc-900/50">
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
                    {entry.tracks_count} tracks · {entry.time_signature} · {entry.tempo} BPM
                  </p>
                  {entry.midi_url ? (
                    <div className="flex gap-3">
                      <a href={entry.midi_url} download className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
                        Download MIDI →
                      </a>
                      <span className="text-zinc-300 dark:text-zinc-700">·</span>
                      <Link to="/" className="text-sm text-zinc-500 dark:text-zinc-400 hover:underline">
                        Re-generate similar →
                      </Link>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-400">No MIDI file available for this entry.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
