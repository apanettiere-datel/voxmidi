import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { MagnifyingGlassIcon } from '@heroicons/react/20/solid'
import { SOUND_LIBRARY, allSounds } from '@/lib/studio/soundLibrary'

// GarageBand Library pattern: a category column on the left, the sounds in that
// category on the right, a search field on top that flattens across categories.
// Picking a sound calls onPick(vibe); the inspector drops it in the (editable)
// sound-words box, so this is a shortcut, never a lock-in.
export default function SoundLibraryBrowser({ part, current, onPick }) {
  const categories = SOUND_LIBRARY[part] || []
  const [cat, setCat] = useState(0)
  const [q, setQ] = useState('')

  const results = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return null
    return allSounds(part).filter((s) => s.name.toLowerCase().includes(query) || s.vibe.toLowerCase().includes(query))
  }, [q, part])

  const list = results ?? (categories[cat]?.sounds || [])

  return (
    <div className="rounded-lg border border-line-strong bg-panel overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-line">
        <MagnifyingGlassIcon className="size-3.5 text-faint shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search sounds..."
          className="flex-1 bg-transparent text-xs text-primary placeholder:text-faint focus:outline-none"
        />
        <span className="text-[10px] text-faint">{list.length} sound{list.length === 1 ? '' : 's'}</span>
      </div>
      <div className="flex h-44">
        {!results && (
          <div className="w-28 shrink-0 border-r border-line overflow-y-auto">
            {categories.map((c, i) => (
              <button
                key={c.category}
                type="button"
                onClick={() => setCat(i)}
                className={clsx('block w-full text-left px-2.5 py-1.5 text-xs transition',
                  i === cat ? 'bg-accent-surface text-accent-text font-medium' : 'text-muted hover:text-primary hover:bg-sunken')}
              >
                {c.category}
              </button>
            ))}
          </div>
        )}
        <div className="flex-1 overflow-y-auto py-1">
          {list.length === 0 && <p className="px-3 py-2 text-xs text-faint">No sounds match.</p>}
          {list.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => onPick(s.vibe)}
              title={s.vibe}
              className={clsx('block w-full text-left px-3 py-1.5 text-xs transition',
                current === s.vibe ? 'bg-accent-surface text-accent-text' : 'text-body hover:bg-sunken hover:text-primary')}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
