import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { SparklesIcon, MusicalNoteIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/20/solid'
import { Button } from '@/components/catalyst/button'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { trackById, updateTrack, totalBars, roleOf, makeTrack, BEATS_PER_BAR } from '@/lib/studio/project'
import { Pill, Callout } from './ui'

// Styles per part, matching backend/app/pipelines/part_render.py
const STYLES = {
  bass: [['finger', 'Finger bass'], ['pick', 'Pick bass'], ['slap', 'Slap bass'], ['upright', 'Upright bass'], ['synth', 'Synth bass']],
  guitar: [['clean', 'Clean electric'], ['acoustic', 'Acoustic'], ['crunch', 'Crunch'], ['distorted', 'Distorted'], ['nylon', 'Nylon']],
  keys: [['piano', 'Piano'], ['rhodes', 'Rhodes'], ['organ', 'Organ'], ['pad', 'Pad']],
  lead: [['guitar', 'Lead guitar'], ['piano', 'Piano'], ['synth', 'Synth lead'], ['flute', 'Flute']],
}
// Which render parts a MIDI track can become
const PARTS_FOR_ROLE = { bass: ['bass'], chords: ['guitar', 'keys'], melody: ['lead', 'guitar'] }
const PART_LABEL = { bass: 'Bass', guitar: 'Guitar', keys: 'Keys', lead: 'Lead' }

const STATUS = {
  queued: 'Waiting in queue...',
  processing: 'Starting...',
  rendering_part: 'Playing your part on a real instrument...',
  generating_audio: 'The AI is playing your part... this takes up to a minute',
  decoding_audio: 'Loading the result...',
  checking_pitch: 'Checking how many notes are still yours...',
}

function signature(notes) {
  let h = 2166136261
  for (const ch of notes.map((n) => `${n.p}:${n.t}:${n.d}:${n.v}`).join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return (h >>> 0).toString(36)
}

export default function RealPartPanel({ trackId }) {
  const authFetch = useAuthFetch()
  const { jobs, startJob, removeJob } = useJobs()
  const { project, setProject, addTake, toast, refreshUsage, usage } = useStudio()
  const track = trackById(project, trackId)
  const parts = PARTS_FOR_ROLE[roleOf(track)] || ['keys']
  const info = project.realParts?.[trackId]
  const [open, setOpen] = useState(!!info)
  const [part, setPart] = useState(info?.part || parts[0])
  const [style, setStyle] = useState(info?.style || STYLES[parts[0]][0][0])
  const [strength, setStrength] = useState(0.4)
  const [jobId, setJobId] = useState(null)
  const [mode, setMode] = useState(null) // 'samples' | 'polish' | 'cover' while running
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!parts.includes(part)) { setPart(parts[0]); setStyle(STYLES[parts[0]][0][0]) }
  }, [trackId])

  const job = jobId ? jobs[jobId] : null
  const realTrack = info && trackById(project, info.audioTrackId)
  const usingReal = !!realTrack && !realTrack.mute
  const stale = info && info.signature !== signature(track.notes)

  useEffect(() => {
    if (!job) return
    if (job.status === 'complete' && job.result) {
      const result = job.result
      removeJob(jobId)
      setJobId(null)
      place(result).catch((e) => setError(`Couldn't load the audio: ${e.message}`)).finally(() => setMode(null))
    } else if (job.status === 'error' || job.status === 'cancelled') {
      setError(job.status === 'cancelled' ? 'Cancelled. Nothing was placed.' : job.error || 'That render failed. Nothing was placed.')
      removeJob(jobId)
      setJobId(null)
      setMode(null)
      refreshUsage()
    }
  }, [job?.status])

  async function place(result) {
    const res = await authFetch(result.audio_url)
    if (!res.ok) throw new Error(`download failed (${res.status})`)
    const buffer = await engine.context().decodeAudioData(await res.arrayBuffer())
    const styleLabel = STYLES[result.part].find(([id]) => id === result.style)?.[1] || result.style
    const take = await addTake(buffer, { name: `${track.name} · ${styleLabel}${result.cover ? ' · AI cover' : result.polish ? ' · AI' : ''}` })
    const clip = { id: `r${Date.now().toString(36)}`, takeId: take.id, startBeat: 0, offset: 0, duration: buffer.duration }
    setProject((p) => {
      let next = p
      let audioId = p.realParts?.[trackId]?.audioTrackId
      if (!audioId || !trackById(next, audioId)) {
        const t = { ...makeTrack(next, 'audio'), name: `${track.name} (real)` }
        const at = next.tracks.findIndex((x) => x.id === trackId) + 1
        next = { ...next, tracks: [...next.tracks.slice(0, at), t, ...next.tracks.slice(at)] }
        audioId = t.id
      }
      next = updateTrack(next, audioId, { clips: [clip], mute: false })
      next = updateTrack(next, trackId, { mute: true })
      const realParts = { ...(next.realParts || {}), [trackId]: { part: result.part, style: result.style, polish: result.polish, cover: result.cover, provider: result.provider, match: result.match, audioTrackId: audioId, signature: signature(trackById(p, trackId).notes) } }
      return { ...next, realParts }
    }, { what: `Made ${track.name} sound real (${styleLabel}${result.cover ? ', AI cover' : result.polish ? ', AI polish' : ''})` })
    refreshUsage()
    toast(result.cover
      ? (result.provider === 'mock' ? 'Preview cover placed (no GPU on this server)' : `AI cover placed · ${result.match}% of your notes kept`)
      : result.polish ? (result.provider === 'mock' ? 'Preview polish placed' : `AI polish placed · ${result.match}% of your notes kept`) : `${track.name} now plays on ${styleLabel}`)
  }

  async function start(which) {
    setError(null)
    setMode(which)
    const cover = which === 'cover'
    const polish = which === 'polish'
    try {
      const body = {
        part, style,
        tempo: project.tempo,
        total_beats: totalBars(project.sections) * BEATS_PER_BAR,
        notes: track.notes.map(({ p, t, d, v }) => ({ p, t: Math.max(0, t), d: Math.max(0.05, d), v })),
        // One slider, two engines: polish (fal) wants "how much the AI plays" (0.2-0.9),
        // cover (ACE-Step) wants audio_cover_strength where 1.0 = keep the notes exactly.
        strength: cover ? +(1 - strength).toFixed(2) : Math.max(0.2, strength),
        ...(cover ? {} : { polish }),
      }
      const res = await authFetch(cover ? '/api/studio/parts/cover' : '/api/studio/parts/real', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(res.status === 429 ? `That's your ${usage?.limit ?? ''} songs for the month.` : err.detail || `Request failed: ${res.status}`)
      }
      const data = await res.json()
      setJobId(data.job_id)
      startJob(data.job_id, { label: `${track.name} · ${cover ? 'AI cover' : polish ? 'AI polish' : 'real instrument'}` })
    } catch (e) {
      setError(e.message)
      setMode(null)
    }
  }

  function hear(which) {
    setProject((p) => updateTrack(updateTrack(p, info.audioTrackId, { mute: which !== 'real' }), trackId, { mute: which === 'real' }), { undoable: false })
  }

  return (
    <div className="flex-none border-t border-line bg-panel">
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-body hover:bg-white/[0.03]">
        {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
        Make {track.name} sound real
        {info && <span className="ml-2 rounded-md bg-emerald-500/15 px-1.5 text-xs text-emerald-400">{usingReal ? 'playing real' : 'playing MIDI'}</span>}
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {parts.length > 1 && (
              <div className="flex rounded-full bg-zinc-800 p-0.5">
                {parts.map((pt) => (
                  <button key={pt} type="button" onClick={() => { setPart(pt); setStyle(STYLES[pt][0][0]) }}
                    className={clsx('rounded-full px-3 py-0.5 text-xs', part === pt ? 'bg-accent-strong text-white' : 'text-faint')}>{PART_LABEL[pt]}</button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {STYLES[part].map(([id, label]) => <Pill key={id} on={style === id} onClick={() => setStyle(id)} className="text-xs">{label}</Pill>)}
            </div>
            {realTrack && (
              <div className="ml-auto flex rounded-full bg-zinc-800 p-0.5">
                {[['real', 'Real'], ['midi', 'MIDI']].map(([k, label]) => (
                  <button key={k} type="button" onClick={() => hear(k)}
                    className={clsx('rounded-full px-3 py-0.5 text-xs', (k === 'real') === usingReal ? 'bg-accent-strong text-white' : 'text-faint')}>{label}</button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button outline disabled={!!mode || !track.notes.length} onClick={() => start('samples')}>
              <MusicalNoteIcon data-slot="icon" />
              {mode === 'samples' ? 'Rendering...' : 'Real Instrument'}
            </Button>
            <span className="text-xs text-faint">Free. Recorded instrument samples play your exact notes.</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Button color="indigo" disabled={!!mode || !track.notes.length} onClick={() => start('cover')}>
              <SparklesIcon data-slot="icon" />
              {mode === 'cover' ? 'Covering...' : 'AI Cover'}
            </Button>
            <span className="text-xs text-faint">Free. The AI on this server plays your part with real-recording sound; slide left to keep your exact notes.</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Button outline disabled={!!mode || !track.notes.length} onClick={() => start('polish')}>
              <SparklesIcon data-slot="icon" />
              {mode === 'polish' ? 'Polishing...' : 'Polish with AI'}
            </Button>
            <span className="text-xs text-faint">Counts as one song. The AI adds a played feel; if it changes your notes, nothing is placed and it isn't counted.</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-muted w-40">Stay close to my part</span>
            <input type="range" min={0} max={0.7} step={0.05} value={strength} onChange={(e) => setStrength(e.target.valueAsNumber)} className="flex-1 min-w-[8rem] max-w-xs accent-indigo-500" />
            <span className="text-xs text-muted">Let the AI play</span>
            <span className="font-mono tabular-nums text-xs text-faint w-10 text-right">{Math.round(strength * 100)}%</span>
          </div>

          {mode && (
            <div className="space-y-1.5">
              <p className="text-sm text-primary animate-pulse">{STATUS[job?.status] || 'Starting...'}</p>
              <div className="w-full bg-zinc-800 rounded-full h-1.5">
                <div className="bg-accent-strong h-1.5 rounded-full transition-all duration-700" style={{ width: `${job?.progress || 5}%` }} />
              </div>
            </div>
          )}
          {error && <Callout title={error}>Your part is untouched.</Callout>}
          {info && !mode && (
            <p className="text-xs text-muted">
              Last render: {STYLES[info.part]?.find(([id]) => id === info.style)?.[1]}
              {info.cover ? (info.provider === 'mock'
                ? ' · preview cover (no GPU on this server)'
                : <> · AI cover · <span className="font-mono tabular-nums">{info.match}%</span> of notes kept</>)
                : info.polish ? (info.provider === 'mock'
                ? ' · preview polish (the AI service is not set up on this server, nothing was counted)'
                : <> · AI polish · <span className="font-mono tabular-nums">{info.match}%</span> of notes kept</>) : ' · real instrument'}
              {stale && <span className="text-amber-400"> · You edited the notes since; render again to hear the changes.</span>}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
