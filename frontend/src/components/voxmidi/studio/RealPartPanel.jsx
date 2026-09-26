import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { SparklesIcon, MusicalNoteIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/20/solid'
import { Button } from '@/components/catalyst/button'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import { useStudio } from '@/lib/studio/StudioContext'
import { trackById, updateTrack, totalBars, roleOf, BEATS_PER_BAR } from '@/lib/studio/project'
import { PART_STYLES as STYLES, noteSignature as signature } from '@/lib/studio/renders'
import { Pill, Callout } from './ui'

// Which render parts a MIDI track can become
const PARTS_FOR_ROLE = { bass: ['bass'], chords: ['guitar', 'keys'], melody: ['lead', 'guitar'] }
const PART_LABEL = { bass: 'Bass', guitar: 'Guitar', keys: 'Keys', lead: 'Lead' }

const STATUS = {
  queued: 'Waiting in queue...',
  processing: 'Starting...',
  rendering_part: 'Playing your part on a real instrument...',
  generating_audio: 'AI polish... this takes up to a minute',
  checking_pitch: 'Checking every note is still yours...',
}

export default function RealPartPanel({ trackId }) {
  const authFetch = useAuthFetch()
  const { jobs } = useJobs()
  const { project, setProject, refreshUsage, usage, renders, renderErrors, startRender, clearRenderError } = useStudio()
  const track = trackById(project, trackId)
  const parts = PARTS_FOR_ROLE[roleOf(track)] || ['keys']
  const info = project.realParts?.[trackId]
  const [open, setOpen] = useState(!!info)
  const [part, setPart] = useState(info?.part || parts[0])
  const [style, setStyle] = useState(info?.style || STYLES[parts[0]][0][0])
  const [strength, setStrength] = useState(0.4)
  const [starting, setStarting] = useState(null) // 'samples' | 'polish' while the request is sent
  const [startError, setStartError] = useState(null)

  useEffect(() => {
    if (!parts.includes(part)) { setPart(parts[0]); setStyle(STYLES[parts[0]][0][0]) }
  }, [trackId])

  // A render keeps running if you leave this screen; the studio places it when it's done
  const jobId = Object.keys(renders).find((id) => renders[id].songId === project.id && renders[id].target === trackId)
  const job = jobId ? jobs[jobId] : null
  const mode = starting || (jobId ? renders[jobId].mode : null)
  const error = startError || renderErrors[`${project.id}:${trackId}`]
  const realTrack = info && trackById(project, info.audioTrackId)
  const usingReal = !!realTrack && !realTrack.mute
  const stale = info && info.signature !== signature(track.notes)

  async function start(polish) {
    setStartError(null)
    clearRenderError(project.id, trackId)
    setStarting(polish ? 'polish' : 'samples')
    try {
      const body = {
        part, style, polish, strength,
        tempo: project.tempo,
        total_beats: totalBars(project.sections) * BEATS_PER_BAR,
        notes: track.notes.map(({ p, t, d, v }) => ({ p, t: Math.max(0, t), d: Math.max(0.05, d), v })),
      }
      const res = await authFetch('/api/studio/parts/real', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(res.status === 429 ? `That's your ${usage?.limit ?? ''} songs for the month.` : err.detail || `Request failed: ${res.status}`)
      }
      const data = await res.json()
      startRender(data.job_id, {
        kind: 'part', songId: project.id, target: trackId, trackId, mode: polish ? 'polish' : 'samples',
        signature: signature(track.notes), label: `${track.name} · ${polish ? 'AI polish' : 'real instrument'}`,
      })
    } catch (e) {
      setStartError(e.message)
    } finally {
      setStarting(null)
    }
  }

  function hear(which) {
    setProject((p) => updateTrack(updateTrack(p, info.audioTrackId, { mute: which !== 'real' }), trackId, { mute: which === 'real' }), { undoable: false })
  }

  return (
    <div className="flex-none border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-zinc-800 dark:text-zinc-200 hover:bg-white/[0.03]">
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
                    className={clsx('rounded-full px-3 py-0.5 text-xs', part === pt ? 'bg-indigo-600 text-white' : 'text-zinc-400')}>{PART_LABEL[pt]}</button>
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
                    className={clsx('rounded-full px-3 py-0.5 text-xs', (k === 'real') === usingReal ? 'bg-indigo-600 text-white' : 'text-zinc-400')}>{label}</button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button outline disabled={!!mode || !track.notes.length} onClick={() => start(false)}>
              <MusicalNoteIcon data-slot="icon" />
              {mode === 'samples' ? 'Rendering...' : 'Real instrument'}
            </Button>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">Free. Recorded instrument samples play your exact notes.</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Button color="indigo" disabled={!!mode || !track.notes.length} onClick={() => start(true)}>
              <SparklesIcon data-slot="icon" />
              {mode === 'polish' ? 'Polishing...' : 'Polish with AI'}
            </Button>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">Counts as one song. The AI adds a played feel; if it changes your notes, nothing is placed and it isn't counted.</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-zinc-500 dark:text-zinc-400 w-40">Stay close to my part</span>
            <input type="range" min={0.2} max={0.7} step={0.05} value={strength} onChange={(e) => setStrength(e.target.valueAsNumber)} className="flex-1 min-w-[8rem] max-w-xs accent-indigo-500" />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Let the AI play</span>
            <span className="font-mono tabular-nums text-xs text-zinc-400 w-10 text-right">{Math.round(strength * 100)}%</span>
          </div>

          {mode && (
            <div className="space-y-1.5">
              <p className="text-sm text-zinc-900 dark:text-white animate-pulse">{STATUS[job?.status] || 'Starting...'}</p>
              <div className="w-full bg-zinc-800 rounded-full h-1.5">
                <div className="bg-indigo-600 h-1.5 rounded-full transition-all duration-700" style={{ width: `${job?.progress || 5}%` }} />
              </div>
            </div>
          )}
          {error && <Callout title={error}>Your part is untouched.</Callout>}
          {info && !mode && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Last render: {STYLES[info.part]?.find(([id]) => id === info.style)?.[1]}
              {info.polish ? (info.provider === 'mock'
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
