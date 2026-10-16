import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import ResultPanel from '@/components/voxmidi/ResultPanel'

export default function SharePage() {
  const { jobId } = useParams()
  const navigate = useNavigate()
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
    <div className="min-h-screen bg-panel">
      {/* Header */}
      <div className="border-b border-line px-4 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-accent-text font-bold text-lg">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-strong text-white text-sm">♪</span>
            VoxMIDI
          </Link>
          <Link
            to="/"
            className="rounded-xl bg-accent-strong hover:bg-accent-strong text-white px-4 py-2 text-sm font-semibold transition"
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
            <p className="font-medium text-muted">This generation wasn't found or has been deleted.</p>
            <Link to="/" className="mt-4 inline-block text-accent-text hover:underline text-sm">
              Make your own →
            </Link>
          </div>
        )}

        {result && (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-bold font-display tracking-tight text-primary">Shared Generation</h1>
              <p className="text-sm text-muted mt-1">
                {result.genre} · {result.tempo} BPM · {result.key}
                {result.prompt && <span className="ml-1 italic">· "{result.prompt}"</span>}
              </p>
            </div>
            <ResultPanel result={result} />
            <div className="rounded-xl border border-accent bg-accent-surface p-5 text-center space-y-3">
              <p className="font-semibold text-indigo-900 dark:text-indigo-200">Create your own AI music</p>
              <p className="text-sm text-accent-text">
                Type any music description and get MIDI + audio in seconds.
              </p>
              <div className="flex items-center justify-center gap-3 flex-wrap">
                <Link
                  to="/"
                  className="inline-block rounded-xl bg-accent-strong hover:bg-accent-strong text-white px-6 py-2.5 font-semibold text-sm transition"
                >
                  Try VoxMIDI →
                </Link>
                <button
                  onClick={() => {
                    sessionStorage.setItem('voxmidi_remix', JSON.stringify({
                      prompt: result.prompt || '',
                      genre: result.genre || 'pop',
                      tempo: result.tempo || 120,
                      key: result.key || 'Am',
                    }))
                    navigate('/')
                  }}
                  className="inline-block rounded-xl border border-accent text-accent-text hover:bg-indigo-100 dark:hover:bg-indigo-900/30 px-6 py-2.5 font-semibold text-sm transition"
                >
                  🔀 Remix This
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
