import { useState } from 'react'

const TRACK_COLORS = [
  '#6366f1', '#f43f5e', '#10b981', '#f59e0b',
  '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16',
]

export default function TrackMixer({
  tracks = [],
  mutedTracks,
  onMutedTracksChange,
  soloTrack,
  onSoloTrackChange,
  onRegenerateTrack,
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Tracks</span>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">
          {tracks.length} track{tracks.length !== 1 ? 's' : ''}
        </span>
      </div>

      {tracks.map((track, i) => {
        const isMuted = mutedTracks.has(i)
        const isSolo = soloTrack === i
        const color = TRACK_COLORS[i % TRACK_COLORS.length]
        const noteCount = track.notes?.length || 0

        return (
          <div
            key={i}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 transition ${
              isMuted
                ? 'opacity-40'
                : 'bg-zinc-50 dark:bg-zinc-800/50'
            }`}
          >
            {/* Color indicator */}
            <div
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />

            {/* Track name */}
            <div className="flex-1 min-w-0">
              <div className="truncate text-sm font-medium text-zinc-900 dark:text-white">
                {track.name || `Track ${i + 1}`}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {noteCount} notes
                {track.program !== undefined && ` · GM ${track.program}`}
              </div>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-1">
              {/* Mute */}
              <button
                onClick={() => {
                  const next = new Set(mutedTracks)
                  if (next.has(i)) next.delete(i)
                  else next.add(i)
                  onMutedTracksChange(next)
                }}
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold transition ${
                  isMuted
                    ? 'bg-red-600 text-white'
                    : 'bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600'
                }`}
                title="Mute"
              >
                M
              </button>

              {/* Solo */}
              <button
                onClick={() => onSoloTrackChange(isSolo ? null : i)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold transition ${
                  isSolo
                    ? 'bg-amber-500 text-white'
                    : 'bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600'
                }`}
                title="Solo"
              >
                S
              </button>

              {/* Regenerate */}
              {onRegenerateTrack && (
                <button
                  onClick={() => onRegenerateTrack(i, track.name)}
                  className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-bold text-zinc-600 transition hover:bg-indigo-100 hover:text-indigo-700 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-indigo-900 dark:hover:text-indigo-300"
                  title="Regenerate this track"
                >
                  ↻
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
