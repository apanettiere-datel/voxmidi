import { useStudio } from '@/lib/studio/StudioContext'

// Monthly usage in the sidebar. The limit is whatever the backend reports.
export default function PlanCard() {
  const { usage } = useStudio()
  if (!usage) return null
  const full = usage.used >= usage.limit
  const pct = Math.min(100, Math.round((usage.used * 100) / Math.max(1, usage.limit)))
  return (
    <div className="mx-2 mb-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">This month</span>
        <span className="font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">
          {usage.used} / {usage.limit} songs
        </span>
      </div>
      <div className="mt-2 h-1 w-full rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className={`h-1 rounded-full transition-all duration-700 ${full ? 'bg-amber-500' : 'bg-indigo-600'}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs leading-4 text-zinc-400 dark:text-zinc-500">
        Regenerating parts inside a song is always free.
      </p>
    </div>
  )
}
