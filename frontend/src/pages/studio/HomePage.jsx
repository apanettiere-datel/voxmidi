import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { MicrophoneIcon, SparklesIcon, Squares2X2Icon, PencilIcon, TrashIcon, ArrowRightIcon } from '@heroicons/react/20/solid'
import { useStudio } from '@/lib/studio/StudioContext'
import { panel, plainBtn } from '@/components/voxmidi/studio/ui'

const STARTS = [
  { icon: MicrophoneIcon, title: 'Play or sing something', sub: 'Record or upload guitar, keys, bass, drums or vocals. We listen for the tempo, key and chords and build the band around you.', href: '/riff', main: true },
  { icon: SparklesIcon, title: 'Describe it', sub: 'Type a mood, a genre or a tempo and get a whole arrangement to edit.', href: '/describe' },
  { icon: Squares2X2Icon, title: 'Tap a groove', sub: 'Tap pads or beatbox a beat and start from the drums.', href: '/tap' },
]

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function SongRow({ song, current, onOpen, onRename, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(song.name)
  const [confirming, setConfirming] = useState(false)

  function commit() {
    setEditing(false)
    if (name.trim() && name.trim() !== song.name) onRename(name)
    else setName(song.name)
  }

  return (
    <li className={clsx('flex items-center gap-3 px-4 py-3', current && 'bg-indigo-500/5')}>
      <div className="flex-1 min-w-0">
        {editing ? (
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setName(song.name); setEditing(false) } }}
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-sm text-zinc-900 dark:text-white" />
        ) : (
          <button type="button" onClick={onOpen} className="block max-w-full truncate text-left text-sm font-medium text-zinc-900 dark:text-white hover:text-indigo-400">
            {song.name}
            {current && <span className="ml-2 rounded-md bg-indigo-500/15 px-1.5 text-xs font-normal text-indigo-300">open</span>}
          </button>
        )}
        <div className="mt-0.5 font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">
          {song.tempo} BPM · {song.key} · {song.bars} bars · {ago(song.updatedAt)}
        </div>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-zinc-400">Delete this song?</span>
          <button type="button" onClick={onDelete} className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-500">Delete</button>
          <button type="button" onClick={() => setConfirming(false)} className={plainBtn}>Keep</button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setEditing(true)} className={plainBtn} aria-label="Rename" title="Rename"><PencilIcon className="size-4" /></button>
          <button type="button" onClick={() => setConfirming(true)} className={clsx(plainBtn, 'hover:text-red-400')} aria-label="Delete" title="Delete"><TrashIcon className="size-4" /></button>
          <button type="button" onClick={onOpen} className={clsx(plainBtn, 'text-indigo-400')}>Open <ArrowRightIcon className="size-4" /></button>
        </div>
      )}
    </li>
  )
}

export default function HomePage() {
  const navigate = useNavigate()
  const { project, songs, openSong, closeSong, renameSong, deleteSong, toast } = useStudio()

  function open(id) {
    if (openSong(id)) navigate('/song')
    else toast("That song couldn't be loaded")
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Make a song</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Start from something you play, or from a description. Every part the AI writes is yours to edit, and your recordings stay audio.{project ? ` ${project.name} stays saved below.` : ''}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {STARTS.map((s) => (
          <button key={s.href} type="button" onClick={() => { closeSong(); navigate(s.href) }}
            className={clsx(panel, 'text-left p-5 flex flex-col gap-2 transition hover:border-indigo-500', s.main && 'sm:col-span-2 !border-indigo-500/60 bg-indigo-500/5')}>
            <s.icon className={clsx('size-6', s.main ? 'text-indigo-400' : 'text-zinc-400')} />
            <span className="text-base font-semibold text-zinc-900 dark:text-white">{s.title}</span>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">{s.sub}</span>
          </button>
        ))}
      </div>

      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Your songs</h2>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">Saved in this browser</span>
        </div>
        {songs.length ? (
          <ul className={clsx(panel, 'divide-y divide-zinc-200 dark:divide-zinc-800 overflow-hidden')}>
            {songs.map((s) => (
              <SongRow key={s.id} song={s} current={project?.id === s.id}
                onOpen={() => open(s.id)} onRename={(n) => renameSong(s.id, n)}
                onDelete={() => { deleteSong(s.id); toast(`Deleted ${s.name}`) }} />
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border-2 border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-400 dark:text-zinc-500">
            No songs yet. Pick a way to start above.
          </div>
        )}
      </section>
    </div>
  )
}
