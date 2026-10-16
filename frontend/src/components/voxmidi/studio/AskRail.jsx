import { useState } from 'react'
import clsx from 'clsx'
import { SparklesIcon, CheckIcon, XMarkIcon } from '@heroicons/react/20/solid'
import { useAuthFetch } from '@/lib/authFetch'
import { useStudio } from '@/lib/studio/StudioContext'
import { planAsk, ASK_SUGGESTIONS } from '@/lib/studio/ask'
import { updateTrack, roleOf, TRACK_COLORS } from '@/lib/studio/project'

export default function AskRail({ onClose, className }) {
  const authFetch = useAuthFetch()
  const { project, setProject, askLog, setAskLog, toast } = useStudio()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const pendingIndex = askLog.findIndex((m) => m.role === 'card' && m.state === 'pending')
  const pending = pendingIndex >= 0 ? askLog[pendingIndex] : null

  function patchCard(i, patch) {
    setAskLog((log) => log.map((m, k) => (k === i ? { ...m, ...patch } : m)))
  }

  // Settle an open card before starting a new one: keeping is the default
  function settlePending(log) {
    return log.map((m) => (m.role === 'card' && m.state === 'pending' ? { ...m, state: 'kept' } : m))
  }

  // Claude writes the change when the server has a key; the rule-based planner
  // answers otherwise. null means "fall back", {error} is shown to the user.
  async function aiAsk(q) {
    try {
      const body = {
        text: q,
        tempo: project.tempo,
        key: project.key || '',
        time_signature: project.time_signature || '4/4',
        sections: project.sections.map(({ kind, bars, chords }) => ({ kind, bars, chords: (chords || []).slice(0, 8) })),
        tracks: project.tracks.filter((t) => t.kind === 'midi').map((t) => ({
          id: t.id, name: t.name, role: roleOf(t), kind: t.kind, sound: t.sound || '',
          notes: t.notes.map(({ p, t: at, d, v }) => ({ p, t: Math.max(0, at), d: Math.max(0.02, d), v })),
        })),
      }
      const res = await authFetch('/api/studio/ask/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (res.status === 503) return null // no key on this server: use the rule-based planner
      if (res.status === 422) {
        const e = await res.json().catch(() => ({}))
        return { error: e.detail || "The AI couldn't make that change." }
      }
      if (!res.ok) return null
      const r = await res.json()
      const track = project.tracks.find((t) => t.id === r.trackId)
      if (!track) return null
      return { trackId: r.trackId, trackName: r.trackName, title: r.title, detail: r.detail, before: track.notes, after: r.notes, ai: true }
    } catch {
      return null
    }
  }

  async function send(raw) {
    const q = raw.trim()
    if (!q || busy) return
    if (pending?.ab === 'before') setProject((p) => updateTrack(p, pending.trackId, { notes: pending.after }), { undoable: false })
    setText('')
    setBusy(true)
    setAskLog((log) => [...settlePending(log), { role: 'user', text: q }])
    const plan = (await aiAsk(q)) || planAsk(project, q)
    setBusy(false)
    if (plan.error) {
      setAskLog((log) => [...log, { role: 'reply', text: plan.error }])
      return
    }
    setProject((p) => updateTrack(p, plan.trackId, { notes: plan.after }), { what: `Ask: ${q}` })
    setAskLog((log) => [...log, { role: 'card', ...plan, state: 'pending', ab: 'after' }])
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

  function undoChange() {
    setProject((p) => updateTrack(p, pending.trackId, { notes: pending.before }), { what: 'Undid an Ask change' })
    setAskLog((log) => log.filter((_, k) => k !== pendingIndex))
    toast('Undone')
  }

  const untouched = project.tracks.length - 1

  return (
    <aside className={clsx('flex flex-col min-h-0 border-l border-line bg-panel', className)}>
      <div className="flex-none flex items-center gap-2 px-4 py-3 border-b border-line">
        <SparklesIcon className="size-4 text-faint" />
        <span className="text-sm font-semibold text-primary">Ask</span>
        <span className="text-xs text-faint truncate">Change parts in plain language</span>
        {onClose && (
          <button type="button" onClick={onClose} className="ml-auto text-faint hover:text-primary" aria-label="Close">
            <XMarkIcon className="size-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3.5 flex flex-col gap-3">
        {askLog.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div key={i} className="self-end max-w-[88%] rounded-xl rounded-br-sm bg-accent-strong text-white px-3 py-2 text-xs leading-4">{m.text}</div>
            )
          }
          if (m.role === 'reply') {
            return <div key={i} className="rounded-xl border border-line bg-zinc-50 dark:bg-zinc-950/60 p-3 text-xs text-muted">{m.text}</div>
          }
          const isPending = m.state === 'pending'
          return (
            <div key={i} className={clsx('rounded-xl border p-3', isPending ? 'border-accent bg-accent-surface' : 'border-line bg-zinc-50 dark:bg-zinc-950/60')}>
              <div className="flex items-start gap-2">
                <span className="mt-1.5 size-2 shrink-0 rounded-sm" style={{ background: TRACK_COLORS[m.trackId] }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-primary leading-5">{m.title}</p>
                  <p className="mt-1 text-xs leading-4 text-muted">{m.detail}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                <span className="rounded-md bg-accent-surface px-1.5 py-0.5 text-xs font-medium text-accent-text">{m.trackName} changed</span>
                {m.ai && <span className="rounded-md bg-zinc-500/15 px-1.5 py-0.5 text-xs font-medium text-faint">AI</span>}
                <span className="rounded-md bg-zinc-500/15 px-1.5 py-0.5 text-xs font-medium text-faint"><span className="font-mono tabular-nums">{untouched}</span> tracks untouched</span>
              </div>
              {isPending && (
                <div className="flex items-center gap-1.5 mt-3">
                  <div className="flex rounded-full bg-zinc-800 p-0.5">
                    {['before', 'after'].map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => showAB(w)}
                        className={clsx('rounded-full px-2.5 py-0.5 text-xs transition', m.ab === w ? (w === 'after' ? 'bg-accent-strong text-white' : 'bg-zinc-600 text-white') : 'text-faint')}
                      >
                        {w === 'before' ? 'Before' : 'After'}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1" />
                  <button type="button" onClick={undoChange} className="rounded-lg border border-zinc-700 px-2.5 py-0.5 text-xs font-medium text-body hover:bg-zinc-800">Undo</button>
                  <button type="button" onClick={keep} className="rounded-lg bg-accent-strong hover:bg-accent px-2.5 py-0.5 text-xs font-medium text-white">Keep</button>
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

        {busy && (
          <div className="rounded-xl border border-line bg-zinc-50 dark:bg-zinc-950/60 p-3 text-xs text-muted animate-pulse">Writing the change...</div>
        )}

        {askLog.length === 0 && !busy && (
          <div className="flex flex-col gap-2">
            <span className="text-xs text-faint">Try one of these</span>
            {ASK_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="text-left rounded-lg border border-line bg-zinc-50 dark:bg-zinc-950/60 px-2.5 py-2 text-xs text-body hover:border-accent hover:text-accent-text transition"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-none p-3 border-t border-line flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text) } }}
          rows={2}
          placeholder="e.g., make the hi-hats busier in the chorus"
          className="w-full rounded-lg border border-line-strong bg-raised px-3 py-2 text-sm text-primary placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-faint">Only the part you name changes.</span>
          <button type="button" onClick={() => send(text)} disabled={busy} className="ml-auto rounded-lg bg-accent-strong hover:bg-accent disabled:opacity-50 px-3 py-1.5 text-sm font-semibold text-white">{busy ? 'Writing...' : 'Ask'}</button>
        </div>
      </div>
    </aside>
  )
}
