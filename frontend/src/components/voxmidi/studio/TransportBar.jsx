import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import {
  PlayIcon, PauseIcon, StopIcon, MicrophoneIcon, ArrowPathIcon, SignalIcon,
  ArrowDownTrayIcon, ArrowUturnLeftIcon, ArrowUturnRightIcon, SparklesIcon,
} from '@heroicons/react/20/solid'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { formatBeat } from '@/lib/studio/project'
import { shortKey } from '@/lib/studio/theory'

const ghost = 'flex items-center justify-center w-[34px] h-[34px] rounded-full transition active:scale-95'

export default function TransportBar({ onExport, onToggleAsk, askOpen }) {
  const navigate = useNavigate()
  const {
    project, playing, togglePlay, stop, loopOn, setLoopOn, metro, setMetro,
    selSection, undo, redo, canUndo, canRedo, toastMsg,
  } = useStudio()
  const readout = useRef(null)

  useEffect(() => engine.subscribe((b) => {
    if (readout.current) readout.current.textContent = formatBeat(b ?? 0)
  }), [])

  const stats = [
    ['Tempo', `${project.tempo} BPM`],
    ['Key', shortKey(project.key)],
    ['Time', project.time_signature || '4/4'],
    ['Loop', loopOn ? project.sections[selSection]?.kind ?? 'Off' : 'Off'],
  ]

  return (
    <div className="flex-none flex items-center gap-4 px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-x-auto">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={togglePlay}
          title="Play (space)"
          className={clsx(ghost, 'w-[38px] h-[38px] text-white shadow-sm', playing ? 'bg-indigo-700' : 'bg-indigo-600 hover:bg-indigo-500')}
        >
          {playing ? <PauseIcon className="size-[18px]" /> : <PlayIcon className="size-[18px]" />}
        </button>
        <button type="button" onClick={stop} title="Stop" className={clsx(ghost, 'text-zinc-400 hover:text-white hover:bg-white/5')}>
          <StopIcon className="size-[18px]" />
        </button>
        <button type="button" onClick={() => { stop(); navigate('/record') }} title="Record" className={clsx(ghost, 'text-red-400 hover:bg-red-500/10')}>
          <MicrophoneIcon className="size-[18px]" />
        </button>
        <button
          type="button"
          onClick={() => setLoopOn(!loopOn)}
          title="Loop the selected section"
          aria-pressed={loopOn}
          className={clsx(ghost, loopOn ? 'text-indigo-300 bg-indigo-500/20' : 'text-zinc-400 hover:bg-white/5')}
        >
          <ArrowPathIcon className="size-[18px]" />
        </button>
        <button
          type="button"
          onClick={() => setMetro(!metro)}
          title="Metronome"
          aria-pressed={metro}
          className={clsx(ghost, metro ? 'text-indigo-300 bg-indigo-500/20' : 'text-zinc-400 hover:bg-white/5')}
        >
          <SignalIcon className="size-[18px]" />
        </button>
      </div>

      <div className="flex items-baseline gap-2.5 px-3 py-1.5 rounded-lg bg-canvas border border-zinc-200 dark:border-zinc-800">
        <span ref={readout} className="font-mono tabular-nums text-lg font-medium text-zinc-900 dark:text-white min-w-[76px]">001.1.00</span>
        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">bar.beat</span>
      </div>

      <div className="flex items-center gap-3.5">
        {stats.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <span className="text-xs text-zinc-400 dark:text-zinc-500">{k}</span>
            <span className="font-mono tabular-nums text-sm font-medium text-zinc-700 dark:text-zinc-300 whitespace-nowrap">{v}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <button type="button" onClick={undo} disabled={!canUndo} title="Undo" className={clsx(ghost, 'text-zinc-400 hover:bg-white/5 disabled:opacity-30')}>
          <ArrowUturnLeftIcon className="size-4" />
        </button>
        <button type="button" onClick={redo} disabled={!canRedo} title="Redo" className={clsx(ghost, 'text-zinc-400 hover:bg-white/5 disabled:opacity-30')}>
          <ArrowUturnRightIcon className="size-4" />
        </button>
      </div>

      <div className="flex-1" />
      <span
        className={clsx('rounded-md bg-indigo-500/15 px-2 py-0.5 text-xs font-medium text-indigo-300 whitespace-nowrap transition-opacity', toastMsg ? 'opacity-100' : 'opacity-0')}
        aria-live="polite"
      >
        {toastMsg || ' '}
      </span>
      {onToggleAsk && (
        <button
          type="button"
          onClick={onToggleAsk}
          aria-pressed={askOpen}
          className={clsx('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition', askOpen ? 'bg-indigo-500/20 text-indigo-300' : 'text-zinc-400 hover:bg-white/5')}
        >
          <SparklesIcon className="size-4" />
          Ask
        </button>
      )}
      <button
        type="button"
        onClick={onExport}
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition"
      >
        <ArrowDownTrayIcon className="size-4" />
        Export
      </button>
    </div>
  )
}
