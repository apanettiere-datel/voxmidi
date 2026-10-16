// Small studio building blocks. Everything here speaks the design-token
// vocabulary from src/design/tokens (bg-panel, border-line, text-muted...),
// so retuning the tokens restyles every page that uses these.

import clsx from 'clsx'
import { ExclamationTriangleIcon, InformationCircleIcon } from '@heroicons/react/20/solid'

export const panel = 'rounded-xl border border-line bg-panel'
export const mono = 'font-mono tabular-nums'
export const outlineBtn = 'inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-transparent px-3 py-1.5 text-xs font-medium text-body hover:bg-raised hover:text-primary disabled:opacity-40 transition'
export const plainBtn = 'inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-muted hover:text-primary hover:bg-sunken transition'

export function StepLabel({ title, hint }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="h-4 w-1 rounded-full bg-accent" />
      <h2 className="font-display text-base font-semibold text-primary">{title}</h2>
      {hint && <span className="text-xs text-faint">{hint}</span>}
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
        on ? 'bg-accent-strong text-white' : 'bg-raised text-body hover:text-primary',
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
      className={clsx('flex w-9 h-5 shrink-0 rounded-full p-0.5 transition', on ? 'bg-accent-strong justify-end' : 'bg-line-strong justify-start')}
    >
      <span className="block w-4 h-4 rounded-full bg-white" />
    </button>
  )
}

export function Callout({ tone = 'danger', title, children, actions }) {
  const tones = {
    danger: 'border-[var(--danger-border)] bg-[var(--danger-surface)] text-[var(--danger-text)]',
    warning: 'border-[var(--warning-border)] bg-[var(--warning-surface)] text-[var(--warning-text)]',
  }
  const Icon = tone === 'danger' ? ExclamationTriangleIcon : InformationCircleIcon
  return (
    <div className={clsx('rounded-xl border p-4', tones[tone])}>
      <div className="flex items-start gap-3">
        <Icon className="size-5 shrink-0 mt-px" />
        <div className="flex-1 min-w-0">
          {title && <p className="text-sm font-semibold text-primary">{title}</p>}
          {children && <div className="mt-1 text-xs text-muted">{children}</div>}
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
          ? 'border-accent bg-accent-surface'
          : 'border-line bg-panel hover:border-line-strong'
      )}
    >
      <Icon className={clsx('size-6', active ? 'text-accent-text' : 'text-faint')} />
      <span className="text-sm font-medium text-primary">{title}</span>
      <span className="text-xs text-muted">{sub}</span>
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
