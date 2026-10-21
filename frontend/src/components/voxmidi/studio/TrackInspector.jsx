import { useState } from 'react'
import clsx from 'clsx'
import { XMarkIcon, SpeakerWaveIcon, TrashIcon } from '@heroicons/react/20/solid'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { trackById, updateTrack, soundsOf, colorOf, roleOf, isAiTrack, fxOf, FX_PRESETS, DEFAULT_FX } from '@/lib/studio/project'
import RealPartPanel from './RealPartPanel'
import GeneratePartPanel from './GeneratePartPanel'
import { Pill, panel } from './ui'

const KNOBS = [
  ['drive', 'Drive', 'Clean', 'Distorted'],
  ['tone', 'Tone', 'Warm', 'Bright'],
  ['reverb', 'Reverb', 'Dry', 'Big room'],
  ['echo', 'Echo', 'Off', 'Dub'],
]

// GarageBand-style track inspector: everything about one track in one place.
// The sound picker, the four effect knobs with presets, volume, and (for MIDI
// tracks) the whole make-it-sound-real block.
export default function TrackInspector({ trackId, onClose }) {
  const { project, setProject } = useStudio()
  const track = trackById(project, trackId)
  const [tab, setTab] = useState(() => (isAiTrack(track) ? 'ai' : 'instrument'))
  if (!track) return null
  const fx = fxOf(track)
  const color = colorOf(track)
  const sameFx = (a, b) => ['drive', 'tone', 'reverb', 'echo'].every((k) => a[k] === b[k])

  const patch = (p, opts) => setProject((prev) => updateTrack(prev, trackId, p), opts)
  const deleteTrack = () => {
    onClose()
    setProject((p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== trackId) }), { what: `Deleted the ${track.name} track` })
  }
  const setFx = (k, v) => patch((t) => ({ fx: { ...fxOf(t), [k]: v } }), { undoable: false })
  const audition = () => {
    if (track.kind !== 'midi') return
    const p = roleOf(track) === 'drums' ? 38 : roleOf(track) === 'bass' ? 45 : 64
    engine.audition(track, { p, t: 0, d: 0.8, v: 100 })
  }

  return (
    <section className={clsx(panel, 'mt-4 overflow-hidden')}>
      <div className="flex items-center gap-2.5 px-5 py-3 border-b border-line" style={{ background: `color-mix(in srgb, ${color} 10%, transparent)` }}>
        <span className="w-1.5 h-5 rounded-full" style={{ background: color }} />
        <input
          value={track.name}
          onChange={(e) => patch({ name: e.target.value.slice(0, 40) }, { undoable: false })}
          className="bg-transparent text-sm font-semibold text-primary focus:outline-none focus:border-b focus:border-line-strong min-w-0"
        />
        <span className="text-xs text-faint">{track.kind === 'midi' ? 'MIDI track' : 'Audio track'}</span>
        <div className="ml-auto flex rounded-full bg-raised p-0.5">
          {[['instrument', isAiTrack(track) ? 'Sound & FX' : 'Instrument'], ['ai', isAiTrack(track) ? 'Regenerate' : 'Generate with AI']].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={clsx('rounded-full px-3 py-1 text-xs font-medium transition', tab === k ? 'bg-accent-strong text-white' : 'text-muted hover:text-primary')}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={deleteTrack}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--danger-text)] hover:bg-[var(--danger-surface)] transition" title="Delete this track">
          <TrashIcon className="size-3.5" />Delete
        </button>
        <button type="button" onClick={onClose} className="grid place-items-center size-6 rounded-md text-muted hover:text-primary hover:bg-sunken" title="Close">
          <XMarkIcon className="size-4" />
        </button>
      </div>

      {tab === 'ai' && (
        <div className="px-5 py-4">
          <GeneratePartPanel trackId={trackId} />
        </div>
      )}

      {tab === 'instrument' && (
      <div className="px-5 py-4 space-y-4">
        <div className="flex items-start gap-8 flex-wrap">
          {/* Sound: the track's instrument or treatment */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted">Sound</p>
            <div className="flex flex-wrap gap-1.5 max-w-sm">
              {soundsOf(track).map((s) => (
                <Pill key={s} on={track.sound === s} onClick={() => { patch({ sound: s }, { what: `${track.name} sound: ${s}` }); setTimeout(audition, 30) }} className="text-xs">{s}</Pill>
              ))}
            </div>
          </div>

          {/* Volume + hear it */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted">Volume</p>
            <div className="flex items-center gap-2">
              <input type="range" min={0} max={100} value={track.vol} onChange={(e) => patch({ vol: e.target.valueAsNumber }, { undoable: false })} className="w-36 accent-indigo-500" />
              <span className="font-mono tabular-nums text-xs text-faint w-7">{track.vol}</span>
              {track.kind === 'midi' && (
                <button type="button" onClick={audition} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-body hover:text-primary hover:border-line-strong" title="Play one note with the current sound and effects">
                  <SpeakerWaveIcon className="size-3.5" />Hear it
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Effects: four knobs, same chain live and in the export */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-medium text-muted">Effects</p>
            {FX_PRESETS.map((p) => (
              <Pill key={p.name} on={sameFx(fx, { ...DEFAULT_FX, ...p.fx })} onClick={() => patch({ fx: { ...p.fx } }, { what: `${track.name} effects: ${p.name}` })} className="text-xs">{p.name}</Pill>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2">
            {KNOBS.map(([key, label, lo, hi]) => (
              <div key={key}>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-body">{label}</span>
                  <span className="font-mono tabular-nums text-[10px] text-faint">{fx[key]}</span>
                </div>
                <input type="range" min={0} max={100} value={fx[key]} onChange={(e) => setFx(key, e.target.valueAsNumber)} className="w-full accent-indigo-500" />
                <div className="flex justify-between text-[9px] text-faint"><span>{lo}</span><span>{hi}</span></div>
              </div>
            ))}
          </div>
        </div>

        {/* MIDI tracks: the AI render block (real instrument / AI cover / sound library) */}
        {track.kind === 'midi' && !isDrumRole(track) && <RealPartPanel trackId={trackId} />}
      </div>
      )}
    </section>
  )
}

const isDrumRole = (t) => roleOf(t) === 'drums'
