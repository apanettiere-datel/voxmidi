import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { CheckIcon, InformationCircleIcon } from '@heroicons/react/20/solid'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine, renderMix } from '@/lib/studio/engine'
import { trackMidi, wavBytes, wavSize, zip, download, formatBytes } from '@/lib/studio/files'
import { slug, totalBars, colorOf, BEATS_PER_BAR } from '@/lib/studio/project'

function Box({ on }) {
  return (
    <span className={clsx('grid place-items-center size-4 shrink-0 rounded text-white', on ? 'bg-indigo-600' : 'border border-zinc-600')}>
      {on && <CheckIcon className="size-3" />}
    </span>
  )
}

export default function ExportDialog({ onClose }) {
  const { project, toast } = useStudio()
  const name = slug(project.name)
  const songSeconds = (totalBars(project.sections) * BEATS_PER_BAR * 60) / project.tempo + 2

  // Every row's size is exact: MIDI is built now, WAV size follows from length
  const rows = useMemo(() => {
    const out = []
    // File names from track names, kept unique ("Keys 2", "keys-2")
    const used = new Set()
    const fileBase = (t) => {
      let base = slug(t.name)
      for (let n = 2; used.has(base); n++) base = `${slug(t.name)}-${n}`
      used.add(base)
      return `${name}_${base}`
    }
    for (const t of project.tracks) {
      if (t.kind === 'midi' && t.notes.length) {
        const bytes = trackMidi(project, t)
        out.push({ id: t.id, file: `${fileBase(t)}.mid`, meta: `MIDI · ${t.notes.length} notes · velocity kept`, size: bytes.length, bytes, color: colorOf(t) })
      } else if (t.kind === 'audio' && t.clips?.length) {
        out.push({ id: t.id, file: `${fileBase(t)}.wav`, meta: `Audio stem · ${t.clips.length} take${t.clips.length > 1 ? 's' : ''} as placed · 16-bit`, size: wavSize(songSeconds), color: colorOf(t), audio: true })
      }
    }
    out.push({ id: 'mix', file: `${name}_mix.wav`, meta: 'Full mix · WAV · 16-bit', size: wavSize(songSeconds), color: 'var(--emerald-500)', audio: true, round: true })
    return out
  }, [project, name, songSeconds])

  const [sel, setSel] = useState(() => Object.fromEntries(rows.map((r) => [r.id, true])))
  const [history, setHistory] = useState(true)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const chosen = rows.filter((r) => sel[r.id])
  const total = chosen.reduce((a, r) => a + r.size, 0)

  async function doExport() {
    setError(null)
    try {
      const files = []
      for (const r of chosen) {
        if (!r.audio) {
          files.push({ name: r.file, bytes: r.bytes })
          continue
        }
        setBusy(r.id === 'mix' ? 'Rendering the mix…' : `Rendering ${r.id}…`)
        const p = r.id === 'mix'
          ? project
          : { ...project, tracks: project.tracks.map((t) => ({ ...t, mute: false, solo: t.id === r.id })) }
        files.push({ name: r.file, bytes: wavBytes(await renderMix(p, engine.takes)) })
      }
      if (history) {
        const { tracks, ...rest } = project
        const doc = {
          ...rest,
          tracks: tracks.map(({ notes, clips, ...t }) => ({ ...t, notes: notes.length, clips })),
          exported_at: new Date().toISOString(),
        }
        files.push({ name: `${name}_history.json`, bytes: new TextEncoder().encode(JSON.stringify(doc, null, 2)) })
      }
      setBusy('Packing…')
      download(zip(files), `${name}.zip`)
      toast(`Exported ${files.length} files`)
      onClose()
    } catch (e) {
      setError(`Export failed: ${e.message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 grid place-items-center p-6 bg-zinc-950/70 backdrop-blur-[2px]">
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="export-title" className="w-[520px] max-w-full max-h-[86vh] overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xl p-6">
        <h2 id="export-title" className="text-lg font-semibold text-zinc-900 dark:text-white">Export</h2>
        <p className="mt-1.5 mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Your MIDI keeps its velocity and timing exactly as it plays here. Swing, humanize, rolls and flams are baked in, nothing is snapped back to the grid.
        </p>

        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setSel((s) => ({ ...s, [r.id]: !s[r.id] }))}
              className="flex items-center gap-2.5 w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 px-3 py-2.5 text-left"
            >
              <Box on={sel[r.id]} />
              <span className={clsx('size-2 shrink-0', r.round ? 'rounded-full' : 'rounded-sm')} style={{ background: r.color }} />
              <div className="min-w-0">
                <div className="font-mono text-xs text-zinc-900 dark:text-white truncate">{r.file}</div>
                <div className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{r.meta}</div>
              </div>
              <span className="ml-auto font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap">{formatBytes(r.size)}</span>
            </button>
          ))}
        </div>

        <div className="h-px bg-zinc-200 dark:bg-zinc-800 my-4" />

        <button type="button" onClick={() => setHistory(!history)} className="flex items-start gap-2.5 w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 px-3 py-2.5 text-left">
          <Box on={history} />
          <div>
            <div className="text-sm text-zinc-900 dark:text-white">Include the project history</div>
            <div className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">Your prompt, sections, edits and recordings list, as a readable JSON file.</div>
          </div>
        </button>

        <div className="flex items-start gap-2 mt-4 rounded-lg bg-zinc-50 dark:bg-zinc-950/60 px-3 py-2.5">
          <InformationCircleIcon className="size-4 shrink-0 mt-px text-zinc-400" />
          <p className="text-xs leading-4 text-zinc-500 dark:text-zinc-400">
            Everything downloads as one <span className="font-mono">.zip</span>. Drag the <span className="font-mono">.mid</span> files straight onto a track in GarageBand, FL Studio, Ableton or Logic and they land with your velocities intact.
          </p>
        </div>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <div className="flex items-center gap-2.5 mt-5">
          <span className="font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">
            {busy || `${chosen.length + (history ? 1 : 0)} files · ${formatBytes(total)}`}
          </span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800">Cancel</button>
          <button
            type="button"
            onClick={doExport}
            disabled={!!busy || (chosen.length === 0 && !history)}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-1.5 text-sm font-semibold text-white"
          >
            Export Files
          </button>
        </div>
      </div>
    </div>
  )
}
