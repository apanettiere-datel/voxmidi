import { useState } from 'react'
import clsx from 'clsx'
import { SparklesIcon, CheckIcon, XMarkIcon } from '@heroicons/react/20/solid'
import { useStudio } from '@/lib/studio/StudioContext'
import { planAsk, ASK_SUGGESTIONS } from '@/lib/studio/ask'
import { updateTrack, TRACK_COLORS } from '@/lib/studio/project'

export default function AskRail({ onClose, className }) {
  const { project, setProject, askLog, setAskLog, toast } = useStudio()
  const [text, setText] = useState('')
  const pendingIndex = askLog.findIndex((m) => m.role === 'card' && m.state === 'pending')
  const pending = pendingIndex >= 0 ? askLog[pendingIndex] : null

  function patchCard(i, patch) {
    setAskLog((log) => log.map((m, k) => (k === i ? { ...m, ...patch } : m)))
  }

  // Settle an open card before starting a new one: keeping is the default
  function settlePending(log) {
    return log.map((m) => (m.role === 'card' && m.state === 'pending' ? { ...m, state: 'kept' } : m))
  }

  function send(raw) {
    const q = raw.trim()
    if (!q) return
    // Plan on the kept change, not on the Before preview
    let base = project
    if (pending?.ab === 'before') {
      base = updateTrack(project, pending.trackId, { notes: pending.after })
      setProject(base, { undoable: false })
    }
    const plan = planAsk(base, q)
    setText('')
    if (plan.error) {
      setAskLog((log) => [...settlePending(log), { role: 'user', text: q }, { role: 'reply', text: plan.error }])
      return
    }
    setProject((p) => updateTrack(p, plan.trackId, { notes: plan.after }), { what: `Ask: ${q}` })
    setAskLog((log) => [...settlePending(log), { role: 'user', text: q }, { role: 'card', ...plan, state: 'pending', ab: 'after' }])
  }

  function showAB(which) {
    if (!pending) return
    setProject((p) => updateTrack(p, pending.trackId, { notes: which === 'before' ? pending.before : pending.after }), { undoable: false })
    patchCard(pendingIndex, { ab: which })
  }

  function keep() {
    if (pending.ab === 'before') setProject((p) => updateTrack(p, pending.trackId, { notes: pending.after }), { undoable: false })
    patchCard(pendingIndex, { state: 'kept', ab: 'after' })
    toast('Kept')
  }

  // Only revert if the track still holds exactly what the Ask wrote, so
  // edits made to it since aren't thrown away
  function undoChange() {
    const notes = project.tracks.find((t) => t.id === pending.trackId)?.notes
    if (notes !== pending.after && notes !== pending.before) {
      patchCard(pendingIndex, { state: 'kept', ab: 'after' })
      toast('This part was edited after the Ask, so it can\'t be undone here. Use Ctrl+Z to step back.')
      return
    }
    if (notes === pending.after) setProject((p) => updateTrack(p, pending.trackId, { notes: pending.before }), { what: 'Undid an Ask change' })
    setAskLog((log) => log.filter((_, k) => k !== pendingIndex))
    toast('Undone')
  }

  const untouched = project.tracks.length - 1

  return (
    <aside className={clsx('flex flex-col min-h-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900', className)}>
      <div className="flex-none flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <SparklesIcon className="size-4 text-zinc-400" />
        <span className="text-sm font-semibold text-zinc-900 dark:text-white">Ask</span>
        <span className="text-xs text-zinc-400 dark:text-zinc-500 truncate">Change parts in plain language</span>
        {onClose && (
          <button type="button" onClick={onClose} className="ml-auto text-zinc-400 hover:text-white" aria-label="Close">
            <XMarkIcon className="size-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3.5 flex flex-col gap-3">
        {askLog.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div key={i} className="self-end max-w-[88%] rounded-xl rounded-br-sm bg-indigo-600 text-white px-3 py-2 text-xs leading-4">{m.text}</div>
            )
          }
          if (m.role === 'reply') {
            return <div key={i} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 p-3 text-xs text-zinc-500 dark:text-zinc-400">{m.text}</div>
          }
          const isPending = m.state === 'pending'
          return (
            <div key={i} className={clsx('rounded-xl border p-3', isPending ? 'border-indigo-700 bg-indigo-500/10' : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60')}>
              <div className="flex items-start gap-2">
                <span className="mt-1.5 size-2 shrink-0 rounded-sm" style={{ background: TRACK_COLORS[m.trackId] }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-white leading-5">{m.title}</p>
                  <p className="mt-1 text-xs leading-4 text-zinc-500 dark:text-zinc-400">{m.detail}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                <span className="rounded-md bg-indigo-500/15 px-1.5 py-0.5 text-xs font-medium text-indigo-300">{m.trackName} changed</span>
                <span className="rounded-md bg-zinc-500/15 px-1.5 py-0.5 text-xs font-medium text-zinc-400"><span className="font-mono tabular-nums">{untouched}</span> tracks untouched</span>
              </div>
              {isPending && (
                <div className="flex items-center gap-1.5 mt-3">
                  <div className="flex rounded-full bg-zinc-800 p-0.5">
                    {['before', 'after'].map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => showAB(w)}
                        className={clsx('rounded-full px-2.5 py-0.5 text-xs transition', m.ab === w ? (w === 'after' ? 'bg-indigo-600 text-white' : 'bg-zinc-600 text-white') : 'text-zinc-400')}
                      >
                        {w === 'before' ? 'Before' : 'After'}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1" />
                  <button type="button" onClick={undoChange} className="rounded-lg border border-zinc-700 px-2.5 py-0.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800">Undo</button>
                  <button type="button" onClick={keep} className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-2.5 py-0.5 text-xs font-medium text-white">Keep</button>
                </div>
              )}
              {m.state === 'kept' && (
                <div className="flex items-center gap-1.5 mt-2.5 text-xs text-emerald-400">
                  <CheckIcon className="size-3.5" />
                  Kept
                </div>
              )}
            </div>
          )
        })}

        {askLog.length === 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400 dark:text-zinc-500">Try one of these</span>
            {ASK_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="text-left rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 px-2.5 py-2 text-xs text-zinc-700 dark:text-zinc-300 hover:border-indigo-700 hover:text-indigo-300 transition"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-none p-3 border-t border-zinc-200 dark:border-zinc-800 flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text) } }}
          rows={2}
          placeholder="e.g., make the hi-hats busier in the chorus"
          className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 dark:text-zinc-500">Only the part you name changes.</span>
          <button type="button" onClick={() => send(text)} disabled={!text.trim()} className="ml-auto rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white">Ask</button>
        </div>
      </div>
    </aside>
  )
}
