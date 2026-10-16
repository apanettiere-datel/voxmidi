import { useStudio } from '@/lib/studio/StudioContext'

// Monthly usage in the sidebar. The limit is whatever the backend reports.
export default function PlanCard() {
  const { usage } = useStudio()
  if (!usage) return null
  const full = usage.used >= usage.limit
  const pct = Math.min(100, Math.round((usage.used * 100) / Math.max(1, usage.limit)))
  return (
    <div className="mx-2 mb-2 rounded-lg border border-line bg-zinc-50 dark:bg-zinc-950/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">This month</span>
        <span className="font-mono tabular-nums text-xs text-faint">
          {usage.used} / {usage.limit} songs
        </span>
      </div>
      <div className="mt-2 h-1 w-full rounded-full bg-raised">
        <div className={`h-1 rounded-full transition-all duration-700 ${full ? 'bg-amber-500' : 'bg-accent-strong'}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs leading-4 text-faint">
        Regenerating parts inside a song is always free.
      </p>
    </div>
  )
}
