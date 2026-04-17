import { useState, useRef, useEffect, useCallback } from 'react'

// ─── Piano key definitions C3→C5 ─────────────────────────────────────────────

const ALL_KEYS = [
  // Octave 3
  { note: 'C3',  midi: 48, black: false, wIdx: 0,  kbKey: 'a' },
  { note: 'C#3', midi: 49, black: true,  wIdx: 0,  kbKey: 'w' },
  { note: 'D3',  midi: 50, black: false, wIdx: 1,  kbKey: 's' },
  { note: 'D#3', midi: 51, black: true,  wIdx: 1,  kbKey: 'e' },
  { note: 'E3',  midi: 52, black: false, wIdx: 2,  kbKey: 'd' },
  { note: 'F3',  midi: 53, black: false, wIdx: 3,  kbKey: 'f' },
  { note: 'F#3', midi: 54, black: true,  wIdx: 3,  kbKey: 't' },
  { note: 'G3',  midi: 55, black: false, wIdx: 4,  kbKey: 'g' },
  { note: 'G#3', midi: 56, black: true,  wIdx: 4,  kbKey: 'y' },
  { note: 'A3',  midi: 57, black: false, wIdx: 5,  kbKey: 'h' },
  { note: 'A#3', midi: 58, black: true,  wIdx: 5,  kbKey: 'u' },
  { note: 'B3',  midi: 59, black: false, wIdx: 6,  kbKey: 'j' },
  // Octave 4
  { note: 'C4',  midi: 60, black: false, wIdx: 7,  kbKey: 'k' },
  { note: 'C#4', midi: 61, black: true,  wIdx: 7,  kbKey: 'o' },
  { note: 'D4',  midi: 62, black: false, wIdx: 8,  kbKey: 'l' },
  { note: 'D#4', midi: 63, black: true,  wIdx: 8,  kbKey: 'p' },
  { note: 'E4',  midi: 64, black: false, wIdx: 9,  kbKey: ';' },
  { note: 'F4',  midi: 65, black: false, wIdx: 10, kbKey: null },
  { note: 'F#4', midi: 66, black: true,  wIdx: 10, kbKey: null },
  { note: 'G4',  midi: 67, black: false, wIdx: 11, kbKey: null },
  { note: 'G#4', midi: 68, black: true,  wIdx: 11, kbKey: null },
  { note: 'A4',  midi: 69, black: false, wIdx: 12, kbKey: null },
  { note: 'A#4', midi: 70, black: true,  wIdx: 12, kbKey: null },
  { note: 'B4',  midi: 71, black: false, wIdx: 13, kbKey: null },
  { note: 'C5',  midi: 72, black: false, wIdx: 14, kbKey: null },
]
const WHITE_KEYS = ALL_KEYS.filter((k) => !k.black)
const BLACK_KEYS = ALL_KEYS.filter((k) => k.black)
const KB_MAP = Object.fromEntries(ALL_KEYS.filter((k) => k.kbKey).map((k) => [k.kbKey, k.note]))
const NOTE_MAP = Object.fromEntries(ALL_KEYS.map((k) => [k.note, k]))
const W = 40  // white key width px
const WH = 120 // white key height px
const BW = 24  // black key width px
const BH = 74  // black key height px

// ─── Chord definitions ────────────────────────────────────────────────────────

const CHORD_ROWS = [
  ['C', 'Cm', 'D', 'Dm', 'E', 'Em', 'F', 'Fm', 'G', 'Gm', 'A', 'Am', 'B', 'Bm'],
  ['Cmaj7', 'Dm7', 'G7', 'Am7', 'Fmaj7', 'Em7', 'Bbmaj7'],
]

// Map chord names to piano note strings for key highlighting
const CHORD_NOTES_MAP = {
  'C':      ['C3','E3','G3'],
  'Cm':     ['C3','D#3','G3'],
  'D':      ['D3','F#3','A3'],
  'Dm':     ['D3','F3','A3'],
  'E':      ['E3','G#3','B3'],
  'Em':     ['E3','G3','B3'],
  'F':      ['F3','A3','C4'],
  'Fm':     ['F3','G#3','C4'],
  'G':      ['G3','B3','D4'],
  'Gm':     ['G3','A#3','D4'],
  'A':      ['A3','C#4','E4'],
  'Am':     ['A3','C4','E4'],
  'B':      ['B3','D#4','F#4'],
  'Bm':     ['B3','D4','F#4'],
  'Cmaj7':  ['C3','E3','G3','B3'],
  'Dm7':    ['D3','F3','A3','C4'],
  'G7':     ['G3','B3','D4','F4'],
  'Am7':    ['A3','C4','E4','G4'],
  'Fmaj7':  ['F3','A3','C4','E4'],
  'Em7':    ['E3','G3','B3','D4'],
  'Bbmaj7': ['A#3','D4','F4','A4'],
}

// ─── WAV encoder ─────────────────────────────────────────────────────────────

function audioBufferToWav(ab) {
  const nc = ab.numberOfChannels
  const sr = ab.sampleRate
  const len = ab.length
  const buf = new ArrayBuffer(44 + len * nc * 2)
  const v = new DataView(buf)
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  ws(0, 'RIFF'); v.setUint32(4, 36 + len * nc * 2, true); ws(8, 'WAVE')
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, nc, true); v.setUint32(24, sr, true)
  v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true)
  ws(36, 'data'); v.setUint32(40, len * nc * 2, true)
  let off = 44
  for (let i = 0; i < len; i++) for (let c = 0; c < nc; c++) {
    v.setInt16(off, Math.max(-1, Math.min(1, ab.getChannelData(c)[i])) * 32767, true)
    off += 2
  }
  return new Blob([buf], { type: 'audio/wav' })
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PianoPanel({ onChordProgressionChange, onMelodyBlobChange }) {
  const [chordProgression, setChordProgression] = useState([])
  const [activeNotes, setActiveNotes] = useState(new Set())
  const [highlightedNotes, setHighlightedNotes] = useState(new Set())
  const [chordLabel, setChordLabel] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [recordedNotes, setRecordedNotes] = useState([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [pianoFocused, setPianoFocused] = useState(false)
  const [melodyBlob, setMelodyBlob] = useState(null)
  const [renderingAudio, setRenderingAudio] = useState(false)

  const synthRef = useRef(null)
  const pianoContainerRef = useRef(null)
  const recordStartRef = useRef(null)
  const noteStartsRef = useRef({})
  const recordedNotesRef = useRef([])
  const isRecordingRef = useRef(false)
  const activeNotesRef = useRef(new Set())
  const pianoFocusedRef = useRef(false)
  const highlightTimeoutRef = useRef(null)
  const heldChordNotesRef = useRef([])

  // Sync refs
  useEffect(() => { isRecordingRef.current = isRecording }, [isRecording])
  useEffect(() => { pianoFocusedRef.current = pianoFocused }, [pianoFocused])

  // Auto-focus piano container on mount so keyboard shortcuts work immediately
  useEffect(() => {
    const t = setTimeout(() => pianoContainerRef.current?.focus(), 100)
    return () => clearTimeout(t)
  }, [])

  // Init Tone.js synth (lazy)
  async function getSynth() {
    if (synthRef.current) return synthRef.current
    const Tone = await import('tone')
    await Tone.start()
    synthRef.current = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.1, sustain: 0.5, release: 0.5 },
    }).toDestination()
    synthRef.current._tone = Tone
    return synthRef.current
  }

  function startNote(note) {
    if (activeNotesRef.current.has(note)) return
    activeNotesRef.current = new Set([...activeNotesRef.current, note])
    setActiveNotes(new Set(activeNotesRef.current))
    getSynth().then((synth) => synth.triggerAttack(note, '+0'))
    if (isRecordingRef.current) {
      noteStartsRef.current[note] = Date.now()
    }
  }

  function stopNote(note) {
    if (!activeNotesRef.current.has(note)) return
    activeNotesRef.current = new Set([...activeNotesRef.current].filter((n) => n !== note))
    setActiveNotes(new Set(activeNotesRef.current))
    getSynth().then((synth) => synth.triggerRelease(note, '+0'))
    if (isRecordingRef.current && noteStartsRef.current[note] != null) {
      const start = (noteStartsRef.current[note] - recordStartRef.current) / 1000
      const duration = (Date.now() - noteStartsRef.current[note]) / 1000
      const entry = { note, start, duration: Math.max(0.05, duration) }
      recordedNotesRef.current = [...recordedNotesRef.current, entry].sort((a, b) => a.start - b.start)
      setRecordedNotes([...recordedNotesRef.current])
      delete noteStartsRef.current[note]
    }
  }

  // Highlight chord notes on piano keys
  function highlightChord(chord) {
    const notes = CHORD_NOTES_MAP[chord] || []
    clearTimeout(highlightTimeoutRef.current)
    setHighlightedNotes(new Set(notes))
    setChordLabel(chord)
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedNotes(new Set())
      setChordLabel('')
    }, 1000)
  }

  function playChordAttack(chord) {
    const notes = CHORD_NOTES_MAP[chord] || []
    heldChordNotesRef.current = notes
    clearTimeout(highlightTimeoutRef.current)
    setHighlightedNotes(new Set(notes))
    setChordLabel(chord)
    getSynth().then((synth) => {
      notes.forEach((note) => synth.triggerAttack(note, '+0'))
    })
  }

  function playChordRelease() {
    const notes = heldChordNotesRef.current
    if (notes.length) {
      getSynth().then((synth) => {
        notes.forEach((note) => synth.triggerRelease(note, '+0'))
      })
    }
    heldChordNotesRef.current = []
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedNotes(new Set())
      setChordLabel('')
    }, 800)
  }

  // Keyboard event handler — active whenever PianoPanel is mounted (not just when div is focused)
  useEffect(() => {
    function onKeyDown(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
      if (e.repeat) return
      const note = KB_MAP[e.key]
      if (note) { e.preventDefault(); startNote(note) }
      if (e.key === ' ') { e.preventDefault(); isPlaying ? stopPlayback() : playback() }
      if (e.key === 'Backspace') { e.preventDefault(); deleteLastNote() }
      if (e.key === 'Enter') { e.preventDefault(); stopRecording() }
    }
    function onKeyUp(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
      const note = KB_MAP[e.key]
      if (note) stopNote(note)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [isPlaying])

  function startRecording() {
    recordedNotesRef.current = []
    setRecordedNotes([])
    setMelodyBlob(null)
    onMelodyBlobChange?.(null)
    recordStartRef.current = Date.now()
    setIsRecording(true)
  }

  function stopRecording() {
    // Release any held notes
    ;[...activeNotesRef.current].forEach(stopNote)
    setIsRecording(false)
  }

  function deleteLastNote() {
    recordedNotesRef.current = recordedNotesRef.current.slice(0, -1)
    setRecordedNotes([...recordedNotesRef.current])
  }

  async function playback() {
    if (!recordedNotesRef.current.length) return
    setIsPlaying(true)
    const synth = await getSynth()
    const Tone = synth._tone
    Tone.Transport.stop()
    Tone.Transport.cancel()
    recordedNotesRef.current.forEach(({ note, start, duration }) => {
      Tone.Transport.scheduleOnce((time) => synth.triggerAttackRelease(note, duration, time), start)
    })
    const total = recordedNotesRef.current.reduce((m, n) => Math.max(m, n.start + n.duration), 0)
    Tone.Transport.scheduleOnce(() => setIsPlaying(false), total + 0.1)
    Tone.Transport.start()
  }

  function stopPlayback() {
    synthRef.current?._tone?.Transport.stop()
    setIsPlaying(false)
  }

  async function renderAudio() {
    const notes = recordedNotesRef.current
    if (!notes.length) return
    setRenderingAudio(true)
    try {
      const Tone = await import('tone')
      const total = notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0) + 0.5
      const toneBuffer = await Tone.Offline(({ transport }) => {
        const s = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'triangle' },
          envelope: { attack: 0.02, decay: 0.1, sustain: 0.5, release: 0.5 },
        }).toDestination()
        notes.forEach(({ note, start, duration }) => {
          s.triggerAttackRelease(note, duration, start)
        })
      }, total)
      const blob = audioBufferToWav(toneBuffer.get())
      setMelodyBlob(blob)
      onMelodyBlobChange?.(blob)
    } catch (e) {
      console.error('Audio render failed:', e)
    } finally {
      setRenderingAudio(false)
    }
  }

  function updateChords(newProg) {
    setChordProgression(newProg)
    onChordProgressionChange?.(newProg)
  }

  function addChord(chord) {
    updateChords([...chordProgression, chord])
  }

  function removeChord(idx) {
    const n = [...chordProgression]
    n.splice(idx, 1)
    updateChords(n)
  }

  function moveChord(from, to) {
    const n = [...chordProgression]
    const [item] = n.splice(from, 1)
    n.splice(to, 0, item)
    updateChords(n)
  }

  const [draggingIdx, setDraggingIdx] = useState(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)

  return (
    <div className="space-y-5">
      {/* Chord Builder */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Chord Progression</p>
          {chordProgression.length > 0 && (
            <button
              onClick={() => updateChords([])}
              className="text-xs text-zinc-400 hover:text-red-500 transition"
            >Clear all</button>
          )}
        </div>

        {/* Chord buttons */}
        {CHORD_ROWS.map((row, ri) => (
          <div key={ri} className="flex flex-wrap gap-1.5">
            {row.map((chord) => (
              <button
                key={chord}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); playChordAttack(chord) }}
                onMouseUp={() => { playChordRelease(); addChord(chord) }}
                onMouseLeave={() => playChordRelease()}
                onTouchStart={(e) => { e.preventDefault(); playChordAttack(chord) }}
                onTouchEnd={() => { playChordRelease(); addChord(chord) }}
                className="rounded-lg px-2.5 py-1 text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 hover:text-indigo-700 dark:hover:text-indigo-300 transition border border-zinc-200 dark:border-zinc-700 select-none"
              >
                {chord}
              </button>
            ))}
          </div>
        ))}

        {/* Progression pills */}
        {chordProgression.length > 0 && (
          <div className="mt-3 space-y-2">
          <button
            type="button"
            onClick={async () => {
              const synth = await getSynth()
              for (let i = 0; i < chordProgression.length; i++) {
                const chord = chordProgression[i]
                const notes = CHORD_NOTES_MAP[chord] || []
                setHighlightedNotes(new Set(notes))
                setChordLabel(chord)
                notes.forEach((n) => synth.triggerAttack(n, '+0'))
                await new Promise((r) => setTimeout(r, 600))
                notes.forEach((n) => synth.triggerRelease(n, '+0'))
                setHighlightedNotes(new Set())
                setChordLabel('')
                await new Promise((r) => setTimeout(r, 100))
              }
            }}
            className="text-xs px-3 py-1 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-800/60 border border-indigo-200 dark:border-indigo-800 transition font-medium"
          >
            ▶ Play Progression
          </button>
          <div className="flex items-center gap-1.5 flex-wrap p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 min-h-[48px]">
            {chordProgression.map((chord, i) => (
              <div
                key={i}
                draggable
                onDragStart={() => setDraggingIdx(i)}
                onDragOver={(e) => { e.preventDefault(); setDragOverIdx(i) }}
                onDrop={() => {
                  if (draggingIdx !== null && draggingIdx !== i) moveChord(draggingIdx, i)
                  setDraggingIdx(null); setDragOverIdx(null)
                }}
                onDragEnd={() => { setDraggingIdx(null); setDragOverIdx(null) }}
                className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold cursor-grab select-none transition ${
                  dragOverIdx === i
                    ? 'bg-indigo-600 text-white scale-105'
                    : 'bg-indigo-600 text-white'
                } ${draggingIdx === i ? 'opacity-40' : 'opacity-100'}`}
              >
                <span>{chord}</span>
                <button
                  type="button"
                  onClick={() => removeChord(i)}
                  className="ml-0.5 text-indigo-200 hover:text-white text-xs leading-none"
                >×</button>
              </div>
            ))}
            <p className="text-xs text-zinc-400 dark:text-zinc-500 ml-1 italic">drag to reorder</p>
          </div>
          </div>
        )}
        {chordProgression.length === 0 && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">Click chords above to build your progression</p>
        )}
      </div>

      <div className="border-t border-zinc-100 dark:border-zinc-800 pt-4 space-y-4">
        {/* Mini Piano */}
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Mini Piano</p>
          <div className="flex items-center gap-2">
            {!isRecording ? (
              <button
                type="button"
                onClick={startRecording}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-700 text-white transition"
              >⏺ Record</button>
            ) : (
              <button
                type="button"
                onClick={stopRecording}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-white transition animate-pulse"
              >⏹ Stop</button>
            )}
            {recordedNotes.length > 0 && !isRecording && (
              <>
                <button
                  type="button"
                  onClick={isPlaying ? stopPlayback : playback}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white transition"
                >
                  {isPlaying ? '⏸ Stop' : '▶ Play'}
                </button>
                <button
                  type="button"
                  onClick={renderAudio}
                  disabled={renderingAudio}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 transition"
                >
                  {renderingAudio ? '⚙️ Rendering...' : melodyBlob ? '✓ Ready to send' : '⬆ Use as melody'}
                </button>
                <button
                  type="button"
                  onClick={() => { recordedNotesRef.current = []; setRecordedNotes([]); setMelodyBlob(null); onMelodyBlobChange?.(null) }}
                  className="text-xs text-zinc-400 hover:text-red-500 transition"
                >Clear</button>
              </>
            )}
          </div>
        </div>

        {/* Focus area for keyboard shortcuts */}
        <div
          ref={pianoContainerRef}
          tabIndex={0}
          onFocus={() => setPianoFocused(true)}
          onBlur={() => setPianoFocused(false)}
          className={`outline-none rounded-xl overflow-x-auto pb-2 ${pianoFocused ? 'ring-2 ring-indigo-500 ring-offset-2 dark:ring-offset-zinc-900' : ''}`}
        >
          {/* Floating chord label */}
          {chordLabel && (
            <div className="text-center mb-1">
              <span className="inline-block rounded-full bg-indigo-600 text-white text-xs font-bold px-3 py-0.5 shadow">
                {chordLabel}
              </span>
            </div>
          )}

          {/* Piano keys */}
          <div
            className="relative mx-auto"
            style={{ width: WHITE_KEYS.length * W, height: WH }}
          >
            {/* White keys */}
            {WHITE_KEYS.map((key) => {
              const active = activeNotes.has(key.note)
              const highlighted = highlightedNotes.has(key.note)
              return (
                <div
                  key={key.note}
                  onMouseDown={(e) => { e.preventDefault(); startNote(key.note) }}
                  onMouseUp={() => stopNote(key.note)}
                  onMouseLeave={() => activeNotes.has(key.note) && stopNote(key.note)}
                  onTouchStart={(e) => { e.preventDefault(); startNote(key.note) }}
                  onTouchEnd={(e) => { e.preventDefault(); stopNote(key.note) }}
                  onTouchCancel={(e) => { e.preventDefault(); stopNote(key.note) }}
                  style={{ left: key.wIdx * W, width: W - 1, height: WH }}
                  className={`absolute top-0 border border-zinc-300 dark:border-zinc-600 rounded-b-md cursor-pointer select-none flex flex-col justify-end items-center pb-1 transition-colors touch-none ${
                    active
                      ? 'bg-indigo-300 dark:bg-indigo-500'
                      : highlighted
                      ? 'bg-indigo-200 dark:bg-indigo-700'
                      : 'bg-white dark:bg-zinc-100 hover:bg-indigo-50 dark:hover:bg-indigo-100'
                  }`}
                >
                  <span className="text-zinc-400 dark:text-zinc-500" style={{ fontSize: 8 }}>
                    {key.kbKey?.toUpperCase() || ''}
                  </span>
                  {key.note.startsWith('C') && (
                    <span className="text-zinc-400 dark:text-zinc-500" style={{ fontSize: 7 }}>
                      {key.note}
                    </span>
                  )}
                </div>
              )
            })}

            {/* Black keys */}
            {BLACK_KEYS.map((key) => {
              const active = activeNotes.has(key.note)
              const highlighted = highlightedNotes.has(key.note)
              const left = key.wIdx * W + W * 0.7 - BW / 2
              return (
                <div
                  key={key.note}
                  onMouseDown={(e) => { e.preventDefault(); startNote(key.note) }}
                  onMouseUp={() => stopNote(key.note)}
                  onMouseLeave={() => activeNotes.has(key.note) && stopNote(key.note)}
                  onTouchStart={(e) => { e.preventDefault(); startNote(key.note) }}
                  onTouchEnd={(e) => { e.preventDefault(); stopNote(key.note) }}
                  onTouchCancel={(e) => { e.preventDefault(); stopNote(key.note) }}
                  style={{ left, width: BW, height: BH, zIndex: 10 }}
                  className={`absolute top-0 rounded-b-md cursor-pointer select-none flex flex-col justify-end items-center pb-1 transition-colors touch-none ${
                    active
                      ? 'bg-indigo-500'
                      : highlighted
                      ? 'bg-indigo-600'
                      : 'bg-zinc-800 dark:bg-zinc-900 hover:bg-zinc-600 dark:hover:bg-zinc-700'
                  }`}
                >
                  <span className="text-zinc-400" style={{ fontSize: 7 }}>
                    {key.kbKey?.toUpperCase() || ''}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center">
          ⌨️ A S D F G H J K - white keys · W E T Y U - black keys · Space=play · Backspace=delete
        </p>

        {/* Recorded notes timeline */}
        {recordedNotes.length > 0 && (
          <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 p-3">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">
              Recorded {recordedNotes.length} note{recordedNotes.length !== 1 ? 's' : ''}
              {melodyBlob ? ' · ✓ Audio rendered - will send as melody' : ''}
            </p>
            <div className="flex flex-wrap gap-1">
              {recordedNotes.map((n, i) => (
                <span
                  key={i}
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-xs bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-mono"
                >
                  {n.note}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
