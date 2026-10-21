import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { SparklesIcon, CheckIcon, XMarkIcon } from '@heroicons/react/20/solid'
import { useAuthFetch } from '@/lib/authFetch'
import { useJobs } from '@/lib/JobsContext'
import { useStudio } from '@/lib/studio/StudioContext'
import { planAsk, ASK_SUGGESTIONS } from '@/lib/studio/ask'
import { placeStem } from '@/lib/studio/bandStem'
import { updateTrack, makeTrack, spliceNotes, sectionRanges, roleOf, colorOf, TRACK_COLORS } from '@/lib/studio/project'

// Apply a card's changes to the project: 'after' lands the edit (adding any
// new tracks), 'before' shows the old notes without removing new tracks.
function applyChanges(project, changes, which) {
  let next = project
  for (const ch of changes) {
    const exists = next.tracks.some((t) => t.id === ch.trackId)
    if (ch.created && !exists) {
      if (which === 'before') continue
      next = { ...next, tracks: [...next.tracks, ch.newTrack] }
      continue
    }
    next = updateTrack(next, ch.trackId, { notes: which === 'before' ? ch.before : ch.after })
  }
  return next
}

// Undo a card completely: old notes back, new tracks gone.
function revertChanges(project, changes) {
  const createdIds = new Set(changes.filter((c) => c.created).map((c) => c.trackId))
  let next = { ...project, tracks: project.tracks.filter((t) => !createdIds.has(t.id)) }
  for (const ch of changes) {
    if (!ch.created) next = updateTrack(next, ch.trackId, { notes: ch.before })
  }
  return next
}

// Chip labels for the scope row: repeated kinds get numbered (Chorus 1, Chorus 2)
function scopeChips(sections) {
  const counts = {}
  for (const s of sections) counts[s.kind] = (counts[s.kind] || 0) + 1
  const seen = {}
  return sections.map((s) => {
    seen[s.kind] = (seen[s.kind] || 0) + 1
    return { id: s.id, label: counts[s.kind] > 1 ? `${s.kind} ${seen[s.kind]}` : s.kind }
  })
}

const PROVIDERS = [['claude', 'Claude'], ['eleven', 'ElevenLabs'], ['minimax', 'MiniMax']]

export default function AskRail({ onClose, className }) {
  const authFetch = useAuthFetch()
  const { jobs, startJob, removeJob } = useJobs()
  const { project, setProject, addTake, askLog, setAskLog, toast } = useStudio()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [scopeId, setScopeId] = useState(null)
  const [provider, setProvider] = useState('claude')
  const [genJobId, setGenJobId] = useState(null)
  const pendingIndex = askLog.findIndex((m) => m.role === 'card' && m.state === 'pending')
  const pending = pendingIndex >= 0 ? askLog[pendingIndex] : null

  // ElevenLabs/MiniMax generation lands an audio track, then logs a reply.
  const genJob = genJobId ? jobs[genJobId] : null
  useEffect(() => {
    if (!genJob) return
    if (genJob.status === 'complete' && genJob.result) {
      const result = genJob.result
      removeJob(genJobId); setGenJobId(null)
      const name = 'AI part'
      placeStem({ authFetch, addTake, setProject, result, trackId: `ai-${Date.now().toString(36)}`, trackName: name, extra: { role: 'ai', aiSongId: result.song_id || `song-${Date.now().toString(36)}` } })
        .then(() => setAskLog((log) => [...log, { role: 'reply', text: result.provider === 'mock' ? 'Placeholder part added (no key configured).' : `Added an AI audio track (${result.provider}).` }]))
        .catch((e) => setAskLog((log) => [...log, { role: 'reply', text: `Couldn't load the audio: ${e.message}` }]))
        .finally(() => setBusy(false))
    } else if (genJob.status === 'error' || genJob.status === 'cancelled') {
      setAskLog((log) => [...log, { role: 'reply', text: genJob.status === 'cancelled' ? 'Cancelled.' : (genJob.error || 'Generation failed.') }])
      removeJob(genJobId); setGenJobId(null); setBusy(false)
    }
  }, [genJob?.status])

  const chips = scopeChips(project.sections)
  function scopeRange() {
    if (!scopeId) return null
    const r = sectionRanges(project.sections).find((x) => x.id === scopeId)
    const chip = chips.find((c) => c.id === scopeId)
    return r && chip ? { start: r.start, end: r.end, label: chip.label } : null
  }

  function patchCard(i, patch) {
    setAskLog((log) => log.map((m, k) => (k === i ? { ...m, ...patch } : m)))
  }

  // Settle an open card before starting a new one: keeping is the default
  function settlePending(log) {
    return log.map((m) => (m.role === 'card' && m.state === 'pending' ? { ...m, state: 'kept' } : m))
  }

  // Claude writes the change when the server has a key; the rule-based planner
  // answers otherwise. null means "fall back", {error} is shown to the user.
  async function aiAsk(q, scope) {
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
      if (scope) body.scope = { start_beat: scope.start, end_beat: scope.end, label: scope.label }
      const res = await authFetch('/api/studio/ask/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (res.status === 503) return null // no key on this server: use the rule-based planner
      if (res.status === 422) {
        const e = await res.json().catch(() => ({}))
        return { error: e.detail || "The AI couldn't make that change." }
      }
      if (!res.ok) return null
      const r = await res.json()
      let proj = project
      const changes = []
      for (const ch of r.changes) {
        if (ch.created) {
          const t = { ...makeTrack(proj, ch.role), id: `${ch.role}-${Math.random().toString(36).slice(2, 8)}`, name: ch.name, notes: ch.notes }
          proj = { ...proj, tracks: [...proj.tracks, t] }
          changes.push({ trackId: t.id, trackName: t.name, created: true, color: TRACK_COLORS[ch.role], before: [], after: ch.notes, newTrack: t })
        } else {
          const track = proj.tracks.find((t) => t.id === ch.trackId)
          if (!track) return null
          const after = scope ? spliceNotes(track.notes, scope.start, scope.end, ch.notes) : ch.notes
          changes.push({ trackId: ch.trackId, trackName: ch.trackName, created: false, color: colorOf(track), before: track.notes, after })
        }
      }
      return { title: r.title, detail: r.detail, ai: true, changes }
    } catch {
      return null
    }
  }

  // ElevenLabs/MiniMax: the ask becomes a generation prompt, landing a new AI
  // audio track (not note edits).
  async function generateAudio(q) {
    setAskLog((log) => [...settlePending(log), { role: 'user', text: q }])
    setBusy(true)
    try {
      const res = await authFetch('/api/studio/song/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, prompt: q, lyrics: '', length_ms: 30000 }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `Request failed: ${res.status}`)
      }
      const data = await res.json()
      setGenJobId(data.job_id)
      startJob(data.job_id, { label: `Ask (${provider})` })
    } catch (e) {
      setAskLog((log) => [...log, { role: 'reply', text: e.message }])
      setBusy(false)
    }
  }

  async function send(raw) {
    const q = raw.trim()
    if (!q || busy) return
    setText('')
    if (provider !== 'claude') { await generateAudio(q); return }
    if (pending?.ab === 'before') setProject((p) => applyChanges(p, pending.changes, 'after'), { undoable: false })
    setBusy(true)
    setAskLog((log) => [...settlePending(log), { role: 'user', text: q }])
    const scope = scopeRange()
    const plan = (await aiAsk(q, scope)) || planAsk(project, q, scope)
    setBusy(false)
    if (plan.error) {
      setAskLog((log) => [...log, { role: 'reply', text: plan.error }])
      return
    }
    if (!plan.ai) plan.changes = plan.changes.map((ch) => ({ ...ch, color: TRACK_COLORS[ch.trackId] }))
    setProject((p) => applyChanges(p, plan.changes, 'after'), { what: `Ask: ${q}` })
    setAskLog((log) => [...log, { role: 'card', ...plan, state: 'pending', ab: 'after' }])
  }

  function showAB(which) {
    if (!pending) return
    setProject((p) => applyChanges(p, pending.changes, which), { undoable: false })
    patchCard(pendingIndex, { ab: which })
  }

  function keep() {
    if (pending.ab === 'before') setProject((p) => applyChanges(p, pending.changes, 'after'), { undoable: false })
    patchCard(pendingIndex, { state: 'kept', ab: 'after' })
    toast('Kept')
  }

  function undoChange() {
    setProject((p) => revertChanges(p, pending.changes), { what: 'Undid an Ask change' })
    setAskLog((log) => log.filter((_, k) => k !== pendingIndex))
    toast('Undone')
  }

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
          const untouched = Math.max(0, project.tracks.length - m.changes.length)
          return (
            <div key={i} className={clsx('rounded-xl border p-3', isPending ? 'border-accent bg-accent-surface' : 'border-line bg-zinc-50 dark:bg-zinc-950/60')}>
              <div className="flex items-start gap-2">
                <span className="mt-1.5 size-2 shrink-0 rounded-sm" style={{ background: m.changes[0]?.color }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-primary leading-5">{m.title}</p>
                  <p className="mt-1 text-xs leading-4 text-muted">{m.detail}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                {m.changes.map((ch) => (
                  <span key={ch.trackId} className="inline-flex items-center gap-1 rounded-md bg-accent-surface px-1.5 py-0.5 text-xs font-medium text-accent-text">
                    <span className="size-1.5 rounded-full" style={{ background: ch.color }} />
                    {ch.trackName} {ch.created ? 'added' : 'changed'}
                  </span>
                ))}
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
        <div className="flex rounded-full bg-zinc-500/15 p-0.5 self-start">
          {PROVIDERS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setProvider(k)}
              className={clsx('rounded-full px-2.5 py-0.5 text-xs font-medium transition', provider === k ? 'bg-accent-strong text-white' : 'text-faint hover:text-body')}>
              {label}
            </button>
          ))}
        </div>
        {provider === 'claude' && (
          <div className="flex flex-wrap items-center gap-1">
            {[{ id: null, label: 'Whole song' }, ...chips].map((c) => (
              <button
                key={c.id ?? 'song'}
                type="button"
                onClick={() => setScopeId(c.id)}
                className={clsx(
                  'rounded-full px-2 py-0.5 text-xs font-medium transition',
                  scopeId === c.id ? 'bg-accent-strong text-white' : 'bg-zinc-500/15 text-faint hover:text-body'
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text) } }}
          rows={2}
          placeholder={provider === 'claude' ? 'e.g., make the hi-hats busier, or add a string pad' : 'Describe a part to generate, e.g. dark pulsing synth bass, 128 BPM'}
          className="w-full rounded-lg border border-line-strong bg-raised px-3 py-2 text-sm text-primary placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-faint">
            {provider !== 'claude' ? 'Adds a new AI audio track.' : scopeId ? 'Only that section changes.' : 'Only the parts you name change.'}
          </span>
          <button type="button" onClick={() => send(text)} disabled={busy} className="ml-auto rounded-lg bg-accent-strong hover:bg-accent disabled:opacity-50 px-3 py-1.5 text-sm font-semibold text-white">{busy ? (provider === 'claude' ? 'Writing...' : 'Generating...') : (provider === 'claude' ? 'Ask' : 'Generate')}</button>
        </div>
      </div>
    </aside>
  )
}
