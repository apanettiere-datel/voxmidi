import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { SparklesIcon, MusicalNoteIcon } from '@heroicons/react/20/solid'
import { Button } from '@/components/catalyst/button'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine, renderMix } from '@/lib/studio/engine'
import { wavBytes } from '@/lib/studio/files'
import { fromServer, NEW_TRACKS, roleOf } from '@/lib/studio/project'
import { placeStem } from '@/lib/studio/bandStem'
import { Callout, panel } from './ui'

const STATUS = {
  queued: 'Waiting in queue...',
  processing: 'Starting...',
  generating_stem: 'Singing it on the local GPU...',
  decoding_audio: 'Decoding audio...',
}

// A composed song from /studio/song/ai -> a fresh client project
function projectFromSong(song, brief) {
  const base = fromServer({
    id: Math.random().toString(36).slice(2, 10),
    prompt: brief,
    tempo: song.tempo,
    key: song.key,
    time_signature: '4/4',
    genre: 'Lo-fi',
    feel: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    sections: song.sections,
    tracks: song.tracks.map((t) => ({
      id: t.role,
      role: t.role,
      name: t.name,
      kind: 'midi',
      sound: NEW_TRACKS.find((n) => n.role === t.role)?.sound || 'Felt piano',
      notes: t.notes,
    })),
  })
  return {
    ...base,
    name: song.title,
    lyrics: song.lyrics,
    caption: song.caption,
    history: [{ at: new Date().toISOString(), what: 'Claude wrote the song', prompt: brief }],
  }
}

export default function SongBuilderPanel() {
  const authFetch = useAuthFetch()
  const { jobs, startJob, removeJob } = useJobs()
  const { project, setProject, addTake, toast } = useStudio()
  const [provider, setProvider] = useState('claude')
  const [brief, setBrief] = useState('')
  const [lyrics, setLyrics] = useState(project?.lyrics || '')
  const [lengthMs, setLengthMs] = useState(60000)
  const [composing, setComposing] = useState(false)
  const [jobId, setJobId] = useState(null)
  const [jobKind, setJobKind] = useState('sing') // 'sing' | 'fullsong'
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  // A newly composed song brings its own lyrics into the editor
  useEffect(() => { setLyrics(project?.lyrics || '') }, [project?.id])

  const job = jobId ? jobs[jobId] : null
  const hasNotes = project?.tracks.some((t) => t.kind === 'midi' && t.notes.length)
  const PROVIDERS = [['claude', 'Claude'], ['eleven', 'ElevenLabs'], ['minimax', 'MiniMax']]

  useEffect(() => {
    if (!job) return
    if (job.status === 'complete' && job.result) {
      const result = job.result
      removeJob(jobId)
      setJobId(null)
      const full = jobKind === 'fullsong'
      const place = full
        ? placeStem({ authFetch, addTake, setProject, result, trackId: 'full-song', trackName: `Full song (${result.provider})`, extra: { role: 'ai', aiSongId: result.song_id || `song-${Date.now().toString(36)}` } })
        : placeStem({ authFetch, addTake, setProject, result, trackId: 'vocals', trackName: 'Vocals' })
      place
        .then(() => toast(result.provider === 'mock' ? 'Placeholder placed (no key configured)' : full ? 'Full song placed' : 'Vocals placed'))
        .catch((e) => setError(`Couldn't load the audio: ${e.message}`))
        .finally(() => setBusy(false))
    } else if (job.status === 'error' || job.status === 'cancelled') {
      setError(job.status === 'cancelled' ? 'Cancelled. Nothing was placed.' : job.error || 'Generation failed. Nothing was placed.')
      removeJob(jobId)
      setJobId(null)
      setBusy(false)
    }
  }, [job?.status])

  async function generateFullSong() {
    setError(null)
    setBusy(true)
    setJobKind('fullsong')
    try {
      const res = await authFetch('/api/studio/song/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, prompt: brief.trim(), lyrics: lyrics.trim().slice(0, 2000), length_ms: lengthMs }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `Request failed: ${res.status}`)
      }
      const data = await res.json()
      setJobId(data.job_id)
      startJob(data.job_id, { label: `Full song (${provider})` })
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  async function composeSong() {
    setError(null)
    setComposing(true)
    try {
      const res = await authFetch('/api/studio/song/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: brief.trim() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `Request failed: ${res.status}`)
      }
      const song = await res.json()
      setProject(() => projectFromSong(song, brief.trim()), { what: 'Claude wrote the song' })
      toast(`Claude wrote "${song.title}"`)
    } catch (e) {
      setError(e.message)
    } finally {
      setComposing(false)
    }
  }

  async function sing() {
    setError(null)
    setBusy(true)
    setJobKind('sing')
    try {
      const words = lyrics.trim()
      if (words !== (project.lyrics || '')) setProject((p) => ({ ...p, lyrics: words }), { undoable: false })
      // The melody is the singer's guide, not a part of the backing: keep it out
      // of the render so the voice doesn't fight an instrument doubling it.
      const guide = { ...project, tracks: project.tracks.map((t) => (roleOf(t) === 'melody' ? { ...t, mute: true, solo: false } : t)) }
      const rendered = await renderMix(guide, engine.takes)
      const bytes = wavBytes(rendered)
      const form = new FormData()
      form.append('mix', new Blob([bytes], { type: 'audio/wav' }), 'mix.wav')
      form.append('part', 'vocals')
      form.append('style', (project.caption || 'lead vocals that fit the song').slice(0, 300))
      if (words) form.append('lyrics', words.slice(0, 2000))
      const res = await authFetch('/api/studio/parts/band', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `Request failed: ${res.status}`)
      }
      const data = await res.json()
      setJobId(data.job_id)
      startJob(data.job_id, { label: 'Vocals' })
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  const LENGTHS = [['30s', 30000], ['1m', 60000], ['2m', 120000]]

  return (
    <section className={clsx(panel, 'p-5 mt-4 space-y-4')}>
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-primary">Make a song</h3>
        <div className="flex rounded-full bg-raised p-0.5">
          {PROVIDERS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setProvider(k)}
              className={clsx('rounded-full px-3 py-1 text-xs font-medium transition', provider === k ? 'bg-accent-strong text-white' : 'text-muted hover:text-primary')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted">
        {provider === 'claude'
          ? 'Claude writes the whole arrangement as editable tracks (form, chords, bass, drums, a vocal melody and lyrics), then the local GPU sings over it. Free.'
          : provider === 'eleven'
          ? 'ElevenLabs generates a finished, produced song as one audio track from your description and lyrics. Not note-editable. Uses ElevenLabs credits.'
          : 'MiniMax generates a finished, produced song as one audio track from your description and lyrics. Not note-editable. Uses fal credits.'}
      </p>

      <div className="flex gap-2 items-start">
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="A warm, hopeful indie pop song about driving home at night with someone you love..."
          className="flex-1 rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm text-primary placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
        />
        {provider === 'claude' && (
          <Button color="indigo" disabled={composing || busy || brief.trim().length < 3} onClick={composeSong}>
            <SparklesIcon data-slot="icon" />
            {composing ? 'Writing...' : 'Compose'}
          </Button>
        )}
      </div>

      <div className="flex gap-2 items-start">
        <textarea
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          maxLength={2000}
          rows={4}
          placeholder="Lyrics with [verse] and [chorus] tags. Leave blank to let it write them."
          className="flex-1 rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm text-primary placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none font-mono"
        />
        {provider === 'claude' && (
          <Button color="indigo" disabled={busy || composing || !hasNotes} onClick={sing}>
            <MusicalNoteIcon data-slot="icon" />
            Sing it
          </Button>
        )}
      </div>

      {provider !== 'claude' && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex rounded-full bg-raised p-0.5 text-xs">
            {LENGTHS.map(([label, ms]) => (
              <button key={ms} type="button" onClick={() => setLengthMs(ms)}
                className={clsx('rounded-full px-2.5 py-0.5 transition', lengthMs === ms ? 'bg-accent-strong text-white' : 'text-faint hover:text-body')}>{label}</button>
            ))}
          </div>
          <Button color="indigo" disabled={busy || brief.trim().length < 3} onClick={generateFullSong}>
            <SparklesIcon data-slot="icon" />
            {busy ? 'Generating...' : 'Generate full song'}
          </Button>
        </div>
      )}

      {(busy || composing) && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-primary animate-pulse">
            {composing ? 'Claude is writing the song...' : STATUS[job?.status] || (jobKind === 'fullsong' ? 'Generating the song...' : 'Rendering mix...')}
          </p>
          <div className="w-full bg-raised rounded-full h-2">
            <div className="bg-accent-strong h-2 rounded-full transition-all duration-700" style={{ width: composing ? '30%' : `${job?.progress || 5}%` }} />
          </div>
        </div>
      )}

      {error && <Callout title={error}>Your tracks are untouched.</Callout>}

      <p className="text-xs text-faint">
        {provider === 'claude'
          ? 'Composing and singing are free and never counted against your song limit. The melody track guides the singer and stays out of the backing mix.'
          : 'The finished song lands as its own audio track you can trim, split and mix. It is not editable as notes; use Claude for an editable arrangement.'}
      </p>
    </section>
  )
}
