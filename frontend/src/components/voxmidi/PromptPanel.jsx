const GENRES = [
  'EDM', 'Lo-fi Hip Hop', 'Trap', 'House', 'Drum & Bass',
  'Synthwave', 'Pop', 'Rock', 'Jazz', 'Classical', 'Ambient', 'R&B',
]

const KEYS = [
  'C', 'Cm', 'D', 'Dm', 'E', 'Em', 'F', 'Fm',
  'G', 'Gm', 'A', 'Am', 'B', 'Bm',
]

export default function PromptPanel({
  prompt, onPromptChange,
  genre, onGenreChange,
  tempo, onTempoChange,
  musicalKey, onKeyChange,
  onGenerate, isProcessing, canGenerate,
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Style & Prompt</h3>

      {/* Genre quick-select */}
      <div className="mt-3 flex flex-wrap gap-2">
        {GENRES.map((g) => (
          <button
            key={g}
            onClick={() => onGenreChange(g.toLowerCase().replace(/[^a-z0-9]/g, '-'))}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              genre === g.toLowerCase().replace(/[^a-z0-9]/g, '-')
                ? 'bg-indigo-600 text-white'
                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      {/* Tempo & Key */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Tempo (BPM)
          </label>
          <div className="mt-1 flex items-center gap-3">
            <input
              type="range"
              min="60"
              max="200"
              value={tempo}
              onChange={(e) => onTempoChange(Number(e.target.value))}
              className="flex-1 accent-indigo-600"
            />
            <span className="w-10 text-right text-sm tabular-nums text-zinc-900 dark:text-white">
              {tempo}
            </span>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Key</label>
          <select
            value={musicalKey}
            onChange={(e) => onKeyChange(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-white"
          >
            {KEYS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Free-form prompt */}
      <div className="mt-4">
        <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Describe what you want (optional)
        </label>
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          rows={3}
          placeholder="e.g., Melodic EDM with arpeggiated synths, sidechain bass, and a euphoric drop. Four-on-the-floor kick with layered hi-hats..."
          className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-white dark:placeholder:text-zinc-500"
        />
      </div>

      {/* Generate button */}
      <div className="mt-6">
        <button
          onClick={onGenerate}
          disabled={isProcessing || !canGenerate}
          className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]"
        >
          {isProcessing ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Processing...
            </span>
          ) : (
            'Generate MIDI'
          )}
        </button>
      </div>
    </div>
  )
}
