import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronDownIcon, PlusIcon, CheckIcon, TrashIcon, FolderOpenIcon } from '@heroicons/react/20/solid'
import { useStudio } from '@/lib/studio/StudioContext'

// The song's name in the header, click for Save / New / Open. Saved songs live
// in the DB with their audio, so they reopen on any device.
export default function ProjectMenu() {
  const { project, saveSong, loadSong, listSongs, deleteSong, newSong, toast } = useStudio()
  const [open, setOpen] = useState(false)
  const [songs, setSongs] = useState(null)
  const [busy, setBusy] = useState(false)
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
  const btnRef = useRef(null)

  useEffect(() => {
    if (!open) return
    // Fixed positioning so the transport bar's horizontal scroll can't clip the menu.
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, left: r.left })
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    window.addEventListener('pointerdown', close)
    listSongs().then(setSongs).catch(() => setSongs([]))
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  async function save(asNew) {
    setBusy(true)
    try {
      if (asNew) project.dbId = undefined // force a create
      const row = await saveSong()
      toast(`Saved "${row.name}"`)
      setOpen(false)
    } catch (e) { toast(`Save failed: ${e.message}`) } finally { setBusy(false) }
  }

  async function open_(id) {
    setBusy(true)
    try { const d = await loadSong(id); toast(`Opened "${d.name || 'song'}"`); setOpen(false) }
    catch (e) { toast(`Open failed: ${e.message}`) } finally { setBusy(false) }
  }

  async function remove(e, id) {
    e.stopPropagation()
    try { await deleteSong(id); setSongs((s) => s.filter((x) => x.id !== id)) }
    catch (err) { toast(`Delete failed: ${err.message}`) }
  }

  return (
    <div ref={ref}>
      <button ref={btnRef} type="button" onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 font-display text-sm font-semibold text-primary hover:text-accent-text transition max-w-[16rem]">
        <span className="truncate">{project.name || 'Untitled song'}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted" />
      </button>
      {open && pos && (
        <div style={{ position: 'fixed', top: pos.top, left: pos.left }} className="z-50 w-64 rounded-xl border border-line-strong bg-raised shadow-xl p-1.5">
          <button type="button" disabled={busy} onClick={() => save(false)}
            className="flex items-center gap-2 w-full rounded-lg px-2.5 py-1.5 text-sm text-body hover:bg-sunken hover:text-primary disabled:opacity-50">
            <CheckIcon className="size-4 text-faint" />{project.dbId ? 'Save' : 'Save song'}
          </button>
          {project.dbId && (
            <button type="button" disabled={busy} onClick={() => save(true)}
              className="flex items-center gap-2 w-full rounded-lg px-2.5 py-1.5 text-sm text-body hover:bg-sunken hover:text-primary disabled:opacity-50">
              <PlusIcon className="size-4 text-faint" />Save as a new song
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => { newSong(); toast('Started a new song'); setOpen(false) }}
            className="flex items-center gap-2 w-full rounded-lg px-2.5 py-1.5 text-sm text-body hover:bg-sunken hover:text-primary disabled:opacity-50">
            <PlusIcon className="size-4 text-faint" />New song
          </button>

          <div className="my-1.5 border-t border-line" />
          <div className="px-2.5 pb-1 text-xs font-medium text-faint flex items-center gap-1.5"><FolderOpenIcon className="size-3.5" />Your songs</div>
          <div className="max-h-64 overflow-y-auto">
            {songs === null && <p className="px-2.5 py-1.5 text-xs text-faint">Loading...</p>}
            {songs !== null && songs.length === 0 && <p className="px-2.5 py-1.5 text-xs text-faint">No saved songs yet.</p>}
            {(songs || []).map((s) => (
              <div key={s.id} className={clsx('group flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm hover:bg-sunken', s.id === project.dbId && 'bg-accent-surface')}>
                <button type="button" disabled={busy} onClick={() => open_(s.id)} className="flex-1 min-w-0 text-left">
                  <span className="block truncate text-body">{s.name}</span>
                  <span className="block text-[10px] text-faint">{s.tempo} BPM</span>
                </button>
                <button type="button" onClick={(e) => remove(e, s.id)} title="Delete this song"
                  className="shrink-0 grid place-items-center size-6 rounded text-faint opacity-0 group-hover:opacity-100 hover:text-[var(--danger-text)]">
                  <TrashIcon className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
