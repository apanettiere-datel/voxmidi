// Small studio building blocks, in the same Tailwind idiom as JamPage and
// DrumGridPage (light classes with dark: variants; the app renders dark).

import clsx from 'clsx'
import { ExclamationTriangleIcon, InformationCircleIcon } from '@heroicons/react/20/solid'

export const panel = 'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900'
export const mono = 'font-mono tabular-nums'
export const outlineBtn = 'inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 disabled:opacity-40 transition'
export const plainBtn = 'inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-white/5 transition'

export function StepLabel({ n, title, hint }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold">{n}</span>
      <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{title}</h2>
      {hint && <span className="text-xs text-zinc-400 dark:text-zinc-500">{hint}</span>}
    </div>
  )
}

export function Pill({ on, onClick, children, className }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded-full px-3 py-1 text-sm font-medium transition',
        on ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700',
        className
      )}
    >
      {children}
    </button>
  )
}

export function Toggle({ on, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={clsx('flex w-9 h-5 shrink-0 rounded-full p-0.5 transition', on ? 'bg-indigo-600 justify-end' : 'bg-zinc-300 dark:bg-zinc-700 justify-start')}
    >
      <span className="block w-4 h-4 rounded-full bg-white" />
    </button>
  )
}

export function Callout({ tone = 'danger', title, children, actions }) {
  const tones = {
    danger: 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400',
    warning: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400',
  }
  const Icon = tone === 'danger' ? ExclamationTriangleIcon : InformationCircleIcon
  return (
    <div className={clsx('rounded-xl border p-4', tones[tone])}>
      <div className="flex items-start gap-3">
        <Icon className="size-5 shrink-0 mt-px" />
        <div className="flex-1 min-w-0">
          {title && <p className="text-sm font-semibold text-zinc-900 dark:text-white">{title}</p>}
          {children && <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{children}</div>}
          {actions && <div className="flex flex-wrap gap-2 mt-3">{actions}</div>}
        </div>
      </div>
    </div>
  )
}

// Clickable card for choosing a starting point
export function ToolCard({ icon: Icon, title, sub, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex-1 min-w-[9rem] rounded-xl border p-4 text-left transition flex flex-col gap-1.5',
        active
          ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30 dark:border-indigo-600'
          : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-zinc-300 dark:hover:border-zinc-700'
      )}
    >
      <Icon className="size-6 text-zinc-400" />
      <span className="text-sm font-medium text-zinc-900 dark:text-white">{title}</span>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{sub}</span>
    </button>
  )
}

// Mirrored waveform strip from a peak envelope
export function Wave({ peaks, stroke = 'var(--waveform)', height = 22, className }) {
  if (!peaks?.length) return null
  const w = 400
  const mid = height / 2
  const top = peaks.map((p, k) => `${((k / peaks.length) * w).toFixed(1)},${(mid - p * mid * 0.95).toFixed(1)}`)
  const bottom = peaks.slice().reverse().map((p, k) => `${(w - (k / peaks.length) * w).toFixed(1)},${(mid + p * mid * 0.95).toFixed(1)}`)
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={clsx('block w-full', className)} style={{ height }}>
      <polyline points={top.concat(bottom).join(' ')} fill="none" stroke={stroke} strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
