import { useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import {
  PlayIcon, PauseIcon, StopIcon, MicrophoneIcon, ArrowPathIcon, SignalIcon,
  ArrowDownTrayIcon, ArrowUturnLeftIcon, ArrowUturnRightIcon, SparklesIcon, MusicalNoteIcon,
} from '@heroicons/react/20/solid'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { formatBeat } from '@/lib/studio/project'
import { shortKey } from '@/lib/studio/theory'

const ghost = 'flex items-center justify-center w-[34px] h-[34px] rounded-full transition active:scale-95'

// The studio owns the whole window, so this header is also its navigation:
// home on the left, then the three editor tabs.
const EDITORS = [
  ['/song', 'Song'],
  ['/song/drums', 'Drums'],
  ['/song/roll', 'Notes'],
]

export default function TransportBar({ onExport, onToggleAsk, askOpen }) {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    project, playing, togglePlay, stop, loopOn, setLoopOn, metro, setMetro,
    selSection, undo, redo, canUndo, canRedo, toastMsg, cursor, cursorRef,
  } = useStudio()
  const readout = useRef(null)

  useEffect(() => engine.subscribe((b) => {
    if (readout.current) readout.current.textContent = formatBeat(b ?? cursorRef.current)
  }), [])

  // Stopped: the readout shows the edit cursor
  useEffect(() => {
    if (!engine.playing && readout.current) readout.current.textContent = formatBeat(cursor)
  }, [cursor])

  const stats = [
    ['Tempo', `${project.tempo} BPM`],
    ['Key', shortKey(project.key)],
    ['Time', project.time_signature || '4/4'],
    ['Loop', loopOn ? project.sections[selSection]?.kind ?? 'Off' : 'Off'],
  ]

  return (
    <div className="flex-none flex items-center gap-4 px-4 py-2.5 border-b border-line bg-panel overflow-x-auto">
      <div className="flex items-center gap-2.5">
        <Link to="/describe" title="Leave the studio" className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-strong shrink-0 hover:opacity-85 transition">
          <MusicalNoteIcon className="h-5 w-5 text-white" />
        </Link>
        <div className="flex rounded-full bg-raised p-0.5">
          {EDITORS.map(([href, label]) => (
            <Link key={href} to={href}
              className={clsx('rounded-full px-3 py-1 text-xs font-medium transition',
                location.pathname === href ? 'bg-accent-strong text-white' : 'text-muted hover:text-primary')}>
              {label}
            </Link>
          ))}
        </div>
        <span className="font-display text-sm font-semibold text-primary truncate max-w-[14rem] max-lg:hidden">{project.name}</span>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={togglePlay}
          title="Play (space)"
          className={clsx(ghost, 'w-[38px] h-[38px] text-white shadow-sm', playing ? 'bg-accent-hover' : 'bg-accent-strong hover:bg-accent')}
        >
          {playing ? <PauseIcon className="size-[18px]" /> : <PlayIcon className="size-[18px]" />}
        </button>
        <button type="button" onClick={stop} title="Stop" className={clsx(ghost, 'text-muted hover:text-primary hover:bg-sunken')}>
          <StopIcon className="size-[18px]" />
        </button>
        <button type="button" onClick={() => { stop(); navigate('/record') }} title="Record" className={clsx(ghost, 'text-[var(--danger-text)] hover:bg-[var(--danger-surface)]')}>
          <MicrophoneIcon className="size-[18px]" />
        </button>
        <button
          type="button"
          onClick={() => setLoopOn(!loopOn)}
          title="Loop the selected section"
          aria-pressed={loopOn}
          className={clsx(ghost, loopOn ? 'text-accent-text bg-accent-surface' : 'text-muted hover:bg-sunken')}
        >
          <ArrowPathIcon className="size-[18px]" />
        </button>
        <button
          type="button"
          onClick={() => setMetro(!metro)}
          title="Metronome"
          aria-pressed={metro}
          className={clsx(ghost, metro ? 'text-accent-text bg-accent-surface' : 'text-muted hover:bg-sunken')}
        >
          <SignalIcon className="size-[18px]" />
        </button>
      </div>

      <div className="flex items-baseline gap-2.5 px-3 py-1.5 rounded-lg bg-canvas border border-line shadow-[inset_0_1px_4px_rgb(0_0_0/0.45)]">
        <span ref={readout} className="font-mono tabular-nums text-lg font-medium text-primary tracking-wide min-w-[76px]">001.1.00</span>
        <span className="font-mono text-xs text-faint">bar.beat</span>
      </div>

      <div className="flex items-center gap-3.5">
        {stats.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <span className="text-xs text-faint">{k}</span>
            <span className="font-mono tabular-nums text-sm font-medium text-body whitespace-nowrap">{v}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <button type="button" onClick={undo} disabled={!canUndo} title="Undo" className={clsx(ghost, 'text-muted hover:bg-sunken disabled:opacity-30')}>
          <ArrowUturnLeftIcon className="size-4" />
        </button>
        <button type="button" onClick={redo} disabled={!canRedo} title="Redo" className={clsx(ghost, 'text-muted hover:bg-sunken disabled:opacity-30')}>
          <ArrowUturnRightIcon className="size-4" />
        </button>
      </div>

      <div className="flex-1" />
      <span
        className={clsx('rounded-md bg-accent-surface px-2 py-0.5 text-xs font-medium text-accent-text whitespace-nowrap transition-opacity', toastMsg ? 'opacity-100' : 'opacity-0')}
        aria-live="polite"
      >
        {toastMsg || ' '}
      </span>
      {onToggleAsk && (
        <button
          type="button"
          onClick={onToggleAsk}
          aria-pressed={askOpen}
          className={clsx('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition', askOpen ? 'bg-accent-surface text-accent-text' : 'text-muted hover:bg-sunken')}
        >
          <SparklesIcon className="size-4" />
          Ask
        </button>
      )}
      <button
        type="button"
        onClick={onExport}
        className="inline-flex items-center gap-1.5 rounded-lg bg-success hover:bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition"
      >
        <ArrowDownTrayIcon className="size-4" />
        Export
      </button>
    </div>
  )
}
