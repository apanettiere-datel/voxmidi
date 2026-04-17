import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import ResultPanel from '@/components/voxmidi/ResultPanel'

export default function SharePage() {
  const { jobId } = useParams()
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/shared/${jobId}`)
      .then((r) => {
        if (!r.ok) throw new Error('Not found')
        return r.json()
      })
      .then((data) => {
        setResult({
          job_id: data.id,
          midi_url: data.midi_url,
          audio_url: data.audio_url,
          vocal_audio_url: data.vocal_audio_url,
          stems: data.stems || {},
          tracks: data.tracks || [],
          tempo: data.tempo,
          key: data.key,
          genre: data.genre,
          prompt: data.prompt,
          provider: data.provider,
          duration: data.duration,
          time_signature: data.time_signature,
          replicate_cost: data.replicate_cost,
        })
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [jobId])

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      {/* Header */}
      <div className="border-b border-zinc-100 dark:border-zinc-800 px-4 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-indigo-600 font-bold text-lg">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white text-sm">♪</span>
            VoxMIDI
          </Link>
          <Link
            to="/"
            className="rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 text-sm font-semibold transition"
          >
            Make your own →
          </Link>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8">
        {loading && (
          <div className="text-center py-20 text-zinc-400">
            <p className="text-4xl mb-4 animate-pulse">🎵</p>
            <p>Loading...</p>
          </div>
        )}

        {error && (
          <div className="text-center py-20 text-zinc-400">
            <p className="text-4xl mb-4">😕</p>
            <p className="font-medium text-zinc-600 dark:text-zinc-400">This generation wasn't found or has been deleted.</p>
            <Link to="/" className="mt-4 inline-block text-indigo-600 hover:underline text-sm">
              Make your own →
            </Link>
          </div>
        )}

        {result && (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-bold text-zinc-900 dark:text-white">Shared Generation</h1>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
                {result.genre} · {result.tempo} BPM · {result.key}
                {result.prompt && <span className="ml-1 italic">· "{result.prompt}"</span>}
              </p>
            </div>
            <ResultPanel result={result} />
            <div className="rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/20 p-5 text-center space-y-3">
              <p className="font-semibold text-indigo-900 dark:text-indigo-200">Create your own AI music</p>
              <p className="text-sm text-indigo-700 dark:text-indigo-300">
                Type any music description and get MIDI + audio in seconds.
              </p>
              <Link
                to="/"
                className="inline-block rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 font-semibold text-sm transition"
              >
                Try VoxMIDI →
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
