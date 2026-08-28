import { useState, useRef } from 'react'
import { useAuthFetch } from '@/lib/authFetch'
import AudioRecorder from '@/components/voxmidi/AudioRecorder'
import DrumGrid from '@/components/voxmidi/DrumGrid'
import { Button } from '@/components/catalyst/button'

// Lane order matches render API expectation
const ALL_LANES    = ['kick', 'snare', 'hat', 'clap', 'tom', 'shaker']
const DEFAULT_LANES = ['kick', 'snare', 'hat']

// Convert API step-int list to boolean array of given size
function intsToGrid(ints, size) {
  const arr = new Array(size).fill(false)
  for (const i of (ints ?? [])) {
    if (i >= 0 && i < size) arr[i] = true
  }
  return arr
}

// Convert boolean array to step-int list for API
function gridToInts(arr) {
  return arr.reduce((acc, v, i) => { if (v) acc.push(i); return acc }, [])
}

// Build an all-false lanes object of the given step count
function emptyLanes(size) {
  return Object.fromEntries(ALL_LANES.map((l) => [l, new Array(size).fill(false)]))
}

// Trim or extend each lane to newTotal, preserving existing steps
function resizeLanes(prev, newTotal) {
  const out = {}
  for (const lane of ALL_LANES) {
    const old = prev[lane] ?? []
    if (newTotal > old.length) {
      out[lane] = [...old, ...new Array(newTotal - old.length).fill(false)]
    } else {
      out[lane] = old.slice(0, newTotal)
    }
  }
  return out
}

// Remap lanes to a new step resolution. factor > 1 = expand (16th->32nd); < 1 = contract (32nd->16th)
function remapLanes(prev, oldTotal, newTotal, factor) {
  const out = {}
  for (const lane of ALL_LANES) {
    const newArr = new Array(newTotal).fill(false)
    for (let i = 0; i < oldTotal; i++) {
      if (!(prev[lane]?.[i])) continue
      const ni = factor > 1 ? i * factor : Math.floor(i / (1 / factor))
      if (ni < newTotal) newArr[ni] = true
    }
    out[lane] = newArr
  }
  return out
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function DrumGridPage() {
  const authFetch = useAuthFetch()

  // Entry
  const [beatboxBlob,  setBeatboxBlob]  = useState(null)
  const [isAnalyzing,  setIsAnalyzing]  = useState(false)
  const [analyzeError, setAnalyzeError] = useState(null)

  // Grid lifecycle
  const [phase,       setPhase]       = useState('entry') // 'entry' | 'ready'
  const [sourceLabel, setSourceLabel] = useState(null)

  // Grid parameters
  const [tempo,        setTempo]        = useState(120)
  const [bars,         setBars]         = useState(2)
  const [stepsPerBeat, setStepsPerBeat] = useState(4)   // 4 = 1/16, 8 = 1/32
  const stepsTotal = bars * stepsPerBeat * 4

  // Grid data — boolean arrays, length always === stepsTotal
  const [lanes, setLanes] = useState(() => emptyLanes(2 * 4 * 4))

  // More percussion disclosure
  const [showMore, setShowMore] = useState(false)

  // Playback
  const audioRef    = useRef(null)
  const [isPlaying,    setIsPlaying]    = useState(false)
  const [playheadStep, setPlayheadStep] = useState(-1)
  const [isRendering,  setIsRendering]  = useState(false)
  const [renderResult, setRenderResult] = useState(null)
  const [renderError,  setRenderError]  = useState(null)
  const [isDirty,      setIsDirty]      = useState(true)

  // ── Grid interaction ──────────────────────────────────────────────────────────

  function handleToggle(lane, idx, val) {
    setLanes((prev) => {
      const copy = [...(prev[lane] ?? [])]
      if (copy[idx] === val) return prev  // no-op, skip re-render
      copy[idx] = val
      return { ...prev, [lane]: copy }
    })
    setIsDirty(true)
  }

  // ── Entry actions ─────────────────────────────────────────────────────────────

  async function handleAnalyze() {
    if (!beatboxBlob) return
    setIsAnalyzing(true)
    setAnalyzeError(null)
    try {
      const form = new FormData()
      form.append('beatbox', beatboxBlob, 'beatbox.webm')
      const res = await authFetch('/api/drums/analyze', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `Analysis failed: ${res.status}`)
      }
      const data = await res.json()
      const newSpb   = data.steps_per_beat ?? 4
      const newTotal = data.steps_total ?? (data.bars ?? 2) * newSpb * 4
      const newBars  = data.bars ?? Math.ceil(newTotal / (newSpb * 4))
      const newLanes = {}
      for (const lane of ALL_LANES) {
        newLanes[lane] = intsToGrid(data.lanes?.[lane], newTotal)
      }
      setTempo(data.tempo ?? 120)
      setStepsPerBeat(newSpb)
      setBars(newBars)
      setLanes(newLanes)
      setSourceLabel(
        [
          'Beatbox analyzed',
          data.tempo ? `${data.tempo} BPM` : null,
          data.duration ? `${data.duration.toFixed(1)}s` : null,
        ].filter(Boolean).join(' · ')
      )
      setRenderResult(null)
      setIsDirty(true)
      setPhase('ready')
    } catch (err) {
      setAnalyzeError(err.message)
    } finally {
      setIsAnalyzing(false)
    }
  }

  function handleStartEmpty() {
    const total = 2 * 4 * 4 // 2 bars, 1/16 steps
    setTempo(120)
    setBars(2)
    setStepsPerBeat(4)
    setLanes(emptyLanes(total))
    setSourceLabel('Empty grid · 2 bars · 120 BPM')
    setRenderResult(null)
    setIsDirty(true)
    setPhase('ready')
  }

  // ── Controls ──────────────────────────────────────────────────────────────────

  function handleTempoChange(e) {
    const v = e.target.valueAsNumber
    if (!isNaN(v) && v >= 40 && v <= 260) {
      setTempo(v)
      setIsDirty(true)
    }
  }

  function handleResolutionToggle() {
    const newSpb   = stepsPerBeat === 4 ? 8 : 4
    const oldTotal = stepsTotal               // bars * stepsPerBeat * 4 (current)
    const newTotal = bars * newSpb * 4
    const factor   = newSpb / stepsPerBeat    // 2 when going 16->32, 0.5 when going 32->16
    setLanes((prev) => remapLanes(prev, oldTotal, newTotal, factor))
    setStepsPerBeat(newSpb)
    setIsDirty(true)
  }

  function handleBarsChange(delta) {
    const newBars = Math.max(1, Math.min(8, bars + delta))
    if (newBars === bars) return
    const newTotal = newBars * stepsPerBeat * 4
    setLanes((prev) => resizeLanes(prev, newTotal))
    setBars(newBars)
    setIsDirty(true)
  }

  function handleClear() {
    setLanes(emptyLanes(stepsTotal))
    setIsDirty(true)
  }

  // ── Play / render ─────────────────────────────────────────────────────────────

  async function handlePlay() {
    // If nothing changed since last render, just replay the existing audio
    if (!isDirty && renderResult?.audio_url) {
      const audio = audioRef.current
      if (audio) {
        audio.currentTime = 0
        audio.play()
        setIsPlaying(true)
      }
      return
    }

    setIsRendering(true)
    setRenderError(null)
    try {
      const body = {
        tempo,
        steps_per_beat: stepsPerBeat,
        steps_total:    stepsTotal,
        lanes: Object.fromEntries(ALL_LANES.map((l) => [l, gridToInts(lanes[l] ?? [])])),
      }
      const res = await authFetch('/api/drums/render', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `Render failed: ${res.status}`)
      }
      const data = await res.json()
      setRenderResult(data)
      setIsDirty(false)
      const audio = audioRef.current
      if (audio && data.audio_url) {
        audio.src = data.audio_url
        audio.load()
        audio.play()
        setIsPlaying(true)
      }
    } catch (err) {
      setRenderError(err.message)
    } finally {
      setIsRendering(false)
    }
  }

  function handleStop() {
    const audio = audioRef.current
    if (audio) audio.pause()
    setIsPlaying(false)
    setPlayheadStep(-1)
  }

  // Playhead animation driven by audio timeupdate
  function handleTimeUpdate() {
    const audio = audioRef.current
    if (!audio || !audio.duration || audio.paused) return
    const stepDuration = 60 / (tempo * stepsPerBeat)
    const step = Math.floor(audio.currentTime / stepDuration) % stepsTotal
    setPlayheadStep(step)
  }

  function handleAudioEnded() {
    setIsPlaying(false)
    setPlayheadStep(-1)
  }

  // ── Visible lanes ─────────────────────────────────────────────────────────────

  const visibleLaneKeys  = showMore ? ALL_LANES : DEFAULT_LANES
  const visibleLanesData = Object.fromEntries(visibleLaneKeys.map((l) => [l, lanes[l] ?? []]))

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Drum Grid</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Beatbox a pattern or start from an empty grid
        </p>
      </div>

      {/* ── Entry section ── */}
      {phase === 'entry' && (
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">

          {/* Path 1: Beatbox it */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Beatbox it</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Record a beatbox take and the AI transcribes it to a step grid
              </p>
            </div>
            <AudioRecorder onRecordingComplete={setBeatboxBlob} />
            {analyzeError && (
              <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3">
                <p className="text-sm text-red-700 dark:text-red-400">{analyzeError}</p>
              </div>
            )}
            <Button
              color="indigo"
              className="w-full justify-center"
              disabled={!beatboxBlob || isAnalyzing}
              onClick={handleAnalyze}
            >
              {isAnalyzing ? 'Analyzing...' : 'Analyze beatbox'}
            </Button>
          </div>

          {/* Path 2: Start empty */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Start empty</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Open a blank grid and draw in your own hits
              </p>
            </div>
            <div className="flex-1 flex items-center">
              <div className="w-full rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/60 px-4 py-3">
                <p className="text-xs font-mono tabular-nums text-zinc-500 dark:text-zinc-400">
                  2 bars · 120 BPM · 1/16 steps
                </p>
              </div>
            </div>
            <Button
              color="dark/zinc"
              className="w-full justify-center"
              onClick={handleStartEmpty}
            >
              Start empty
            </Button>
          </div>
        </section>
      )}

      {/* ── Grid section ── */}
      {phase === 'ready' && (
        <>
          {/* Source info + controls */}
          <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">

            {/* Source banner */}
            {sourceLabel && (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center rounded-full bg-emerald-100 dark:bg-emerald-950/60 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    Active
                  </span>
                  <span className="font-mono tabular-nums text-sm text-zinc-600 dark:text-zinc-400">
                    {sourceLabel}
                  </span>
                </div>
                <button
                  type="button"
                  className="text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 transition"
                  onClick={() => setPhase('entry')}
                >
                  Change source
                </button>
              </div>
            )}

            {/* Controls row */}
            <div className="flex items-center gap-4 flex-wrap">

              {/* Tempo */}
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0">
                  Tempo
                </label>
                <input
                  type="number"
                  min={40}
                  max={260}
                  value={tempo}
                  onChange={handleTempoChange}
                  className="w-16 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-sm font-mono tabular-nums text-zinc-900 dark:text-white text-center focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <span className="text-xs text-zinc-500 dark:text-zinc-400">BPM</span>
              </div>

              {/* Resolution toggle */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Steps</span>
                <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-xs font-medium">
                  <button
                    type="button"
                    onClick={() => stepsPerBeat !== 4 && handleResolutionToggle()}
                    className={`px-3 py-1 transition ${
                      stepsPerBeat === 4
                        ? 'bg-indigo-600 text-white'
                        : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700'
                    }`}
                  >
                    1/16
                  </button>
                  <button
                    type="button"
                    onClick={() => stepsPerBeat !== 8 && handleResolutionToggle()}
                    className={`px-3 py-1 transition border-l border-zinc-200 dark:border-zinc-700 ${
                      stepsPerBeat === 8
                        ? 'bg-indigo-600 text-white'
                        : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700'
                    }`}
                  >
                    1/32
                  </button>
                </div>
              </div>

              {/* Bars */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Bars</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleBarsChange(-1)}
                    disabled={bars <= 1}
                    className="flex items-center justify-center w-7 h-7 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700 disabled:opacity-40 transition"
                  >
                    -
                  </button>
                  <span className="w-6 text-center font-mono tabular-nums text-sm text-zinc-900 dark:text-white select-none">
                    {bars}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleBarsChange(1)}
                    disabled={bars >= 8}
                    className="flex items-center justify-center w-7 h-7 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700 disabled:opacity-40 transition"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Clear */}
              <button
                type="button"
                onClick={handleClear}
                className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition"
              >
                Clear
              </button>
            </div>
          </section>

          {/* Grid panel */}
          <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-3">
            <DrumGrid
              lanes={visibleLanesData}
              stepsTotal={stepsTotal}
              stepsPerBeat={stepsPerBeat}
              playheadStep={playheadStep}
              onToggle={handleToggle}
            />

            {/* More percussion disclosure */}
            <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setShowMore((v) => !v)}
                className="text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition"
              >
                {showMore ? 'Fewer percussion tracks' : 'More percussion'}
              </button>
            </div>
          </section>

          {/* Play + download panel */}
          <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                color="indigo"
                disabled={isRendering || isPlaying}
                onClick={handlePlay}
              >
                {isRendering ? 'Rendering...' : 'Play pattern'}
              </Button>

              {isPlaying && (
                <button
                  type="button"
                  onClick={handleStop}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition"
                >
                  Stop
                </button>
              )}

              {isDirty && renderResult && !isPlaying && (
                <span className="text-xs text-zinc-400 dark:text-zinc-500">
                  Grid changed since last render
                </span>
              )}
            </div>

            {/* Download links, shown after a successful render */}
            {renderResult && (
              <div className="flex flex-wrap gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
                {renderResult.audio_url && (
                  <a
                    href={renderResult.audio_url}
                    download
                    className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition"
                  >
                    Download audio
                  </a>
                )}
                {renderResult.midi_url && (
                  <a
                    href={renderResult.midi_url}
                    download
                    className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition"
                  >
                    Download MIDI
                  </a>
                )}
              </div>
            )}

            {/* Render error */}
            {renderError && (
              <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3">
                <p className="text-sm text-red-700 dark:text-red-400">{renderError}</p>
              </div>
            )}
          </section>
        </>
      )}

      {/* Hidden audio element — single instance drives playback and playhead */}
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleAudioEnded}
        onPlay={() => setIsPlaying(true)}
        onPause={() => { if (audioRef.current && !audioRef.current.ended) setIsPlaying(false) }}
        className="hidden"
      />
    </div>
  )
}
