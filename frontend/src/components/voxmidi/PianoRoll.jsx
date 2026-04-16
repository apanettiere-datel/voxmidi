import { useRef, useEffect, useState, useCallback } from 'react'

const TRACK_COLORS = [
  { bg: 'rgba(99, 102, 241, 0.7)', border: '#6366f1' },   // indigo
  { bg: 'rgba(244, 63, 94, 0.7)', border: '#f43f5e' },     // rose
  { bg: 'rgba(16, 185, 129, 0.7)', border: '#10b981' },    // emerald
  { bg: 'rgba(245, 158, 11, 0.7)', border: '#f59e0b' },    // amber
  { bg: 'rgba(139, 92, 246, 0.7)', border: '#8b5cf6' },    // violet
  { bg: 'rgba(6, 182, 212, 0.7)', border: '#06b6d4' },     // cyan
  { bg: 'rgba(236, 72, 153, 0.7)', border: '#ec4899' },    // pink
  { bg: 'rgba(132, 204, 22, 0.7)', border: '#84cc16' },    // lime
]

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteToName(noteNum) {
  const octave = Math.floor(noteNum / 12) - 1
  const name = NOTE_NAMES[noteNum % 12]
  return `${name}${octave}`
}

function isBlackKey(noteNum) {
  const n = noteNum % 12
  return [1, 3, 6, 8, 10].includes(n)
}

export default function PianoRoll({
  tracks = [],
  tempo = 120,
  duration = 10,
  width = 800,
  height = 400,
  mutedTracks = new Set(),
  playheadSecs = 0,
}) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [scrollX, setScrollX] = useState(0)
  const [scrollY, setScrollY] = useState(0)
  const [hoveredNote, setHoveredNote] = useState(null)
  const [canvasWidth, setCanvasWidth] = useState(width)

  // Find the pitch range across all visible tracks
  const visibleNotes = tracks
    .filter((_, i) => !mutedTracks.has(i))
    .flatMap((t) => t.notes || [])

  const minPitch = visibleNotes.length > 0
    ? Math.max(0, Math.min(...visibleNotes.map((n) => n.pitch)) - 4)
    : 48
  const maxPitch = visibleNotes.length > 0
    ? Math.min(127, Math.max(...visibleNotes.map((n) => n.pitch)) + 4)
    : 84
  const pitchRange = maxPitch - minPitch + 1

  // Layout constants
  const keyWidth = 48
  const noteHeight = Math.max(8, Math.min(20, height / pitchRange))
  const pixelsPerSecond = 100
  const totalWidth = keyWidth + duration * pixelsPerSecond
  const totalHeight = pitchRange * noteHeight

  // Responsive width
  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasWidth(entry.contentRect.width)
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1

    canvas.width = canvasWidth * dpr
    canvas.height = height * dpr
    ctx.scale(dpr, dpr)

    // Background
    ctx.fillStyle = '#09090b' // zinc-950
    ctx.fillRect(0, 0, canvasWidth, height)

    // Draw piano key lanes
    for (let pitch = minPitch; pitch <= maxPitch; pitch++) {
      const y = (maxPitch - pitch) * noteHeight - scrollY
      if (y < -noteHeight || y > height) continue

      // Lane background
      ctx.fillStyle = isBlackKey(pitch) ? '#18181b' : '#1c1c20'
      ctx.fillRect(keyWidth, y, canvasWidth - keyWidth, noteHeight)

      // Lane border
      ctx.strokeStyle = '#27272a'
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(keyWidth, y + noteHeight)
      ctx.lineTo(canvasWidth, y + noteHeight)
      ctx.stroke()

      // Piano key labels
      if (pitch % 12 === 0 || pitch === minPitch) {
        ctx.fillStyle = '#71717a'
        ctx.font = '10px monospace'
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.fillText(noteToName(pitch), keyWidth - 6, y + noteHeight / 2)
      }
    }

    // Draw beat grid lines
    const beatDuration = 60 / tempo
    const beatsTotal = Math.ceil(duration / beatDuration)
    for (let beat = 0; beat <= beatsTotal; beat++) {
      const x = keyWidth + beat * beatDuration * pixelsPerSecond - scrollX
      if (x < keyWidth || x > canvasWidth) continue

      const isMeasure = beat % 4 === 0
      ctx.strokeStyle = isMeasure ? '#3f3f46' : '#27272a'
      ctx.lineWidth = isMeasure ? 1 : 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()

      // Beat number
      if (isMeasure) {
        ctx.fillStyle = '#52525b'
        ctx.font = '10px monospace'
        ctx.textAlign = 'left'
        ctx.fillText(`${beat / 4 + 1}`, x + 3, 12)
      }
    }

    // Draw notes
    tracks.forEach((track, trackIndex) => {
      if (mutedTracks.has(trackIndex)) return
      const color = TRACK_COLORS[trackIndex % TRACK_COLORS.length]
      const notes = track.notes || []

      notes.forEach((note) => {
        const x = keyWidth + note.start * pixelsPerSecond - scrollX
        const w = Math.max(2, (note.end - note.start) * pixelsPerSecond)
        const y = (maxPitch - note.pitch) * noteHeight - scrollY

        if (x + w < keyWidth || x > canvasWidth || y < -noteHeight || y > height) return

        // Note rectangle
        ctx.fillStyle = color.bg
        ctx.fillRect(x, y + 1, w, noteHeight - 2)

        // Note border
        ctx.strokeStyle = color.border
        ctx.lineWidth = 1
        ctx.strokeRect(x, y + 1, w, noteHeight - 2)

        // Velocity indicator (brightness of left edge)
        const velWidth = Math.min(3, w / 4)
        ctx.fillStyle = color.border
        ctx.fillRect(x, y + 1, velWidth, noteHeight - 2)
      })
    })

    // Playhead
    if (playheadSecs > 0) {
      const px = keyWidth + playheadSecs * pixelsPerSecond - scrollX
      if (px >= keyWidth && px <= canvasWidth) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(px, 0)
        ctx.lineTo(px, height)
        ctx.stroke()
        // Small triangle at top
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
        ctx.beginPath()
        ctx.moveTo(px - 5, 0)
        ctx.lineTo(px + 5, 0)
        ctx.lineTo(px, 7)
        ctx.closePath()
        ctx.fill()
      }
    }

    // Key column background
    ctx.fillStyle = '#09090b'
    ctx.fillRect(0, 0, keyWidth, height)

    // Redraw key labels on top
    for (let pitch = minPitch; pitch <= maxPitch; pitch++) {
      const y = (maxPitch - pitch) * noteHeight - scrollY
      if (y < -noteHeight || y > height) continue

      const isBlack = isBlackKey(pitch)
      ctx.fillStyle = isBlack ? '#27272a' : '#3f3f46'
      ctx.fillRect(0, y, keyWidth - 1, noteHeight)

      ctx.strokeStyle = '#18181b'
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(0, y + noteHeight)
      ctx.lineTo(keyWidth - 1, y + noteHeight)
      ctx.stroke()

      if (pitch % 12 === 0 || pitchRange <= 24) {
        ctx.fillStyle = isBlack ? '#71717a' : '#a1a1aa'
        ctx.font = `${Math.min(10, noteHeight - 2)}px monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(noteToName(pitch), keyWidth / 2, y + noteHeight / 2)
      }
    }

    // Hovered note tooltip
    if (hoveredNote) {
      const tooltipText = `${noteToName(hoveredNote.pitch)} | vel:${hoveredNote.velocity} | ${hoveredNote.start.toFixed(2)}s`
      ctx.fillStyle = 'rgba(0,0,0,0.8)'
      const tw = ctx.measureText(tooltipText).width + 12
      ctx.fillRect(hoveredNote._x - tw / 2, hoveredNote._y - 22, tw, 18)
      ctx.fillStyle = '#e4e4e7'
      ctx.font = '11px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(tooltipText, hoveredNote._x, hoveredNote._y - 13)
    }
  }, [tracks, mutedTracks, scrollX, scrollY, canvasWidth, height, tempo, duration, hoveredNote, minPitch, maxPitch, pitchRange, noteHeight, playheadSecs])

  // Auto-scroll to keep playhead visible
  useEffect(() => {
    if (playheadSecs <= 0) return
    const px = playheadSecs * pixelsPerSecond
    const viewStart = scrollX
    const viewEnd = scrollX + canvasWidth - keyWidth
    const margin = 80
    if (px > viewEnd - margin) {
      setScrollX(px - (canvasWidth - keyWidth) / 2)
    } else if (px < viewStart + margin && scrollX > 0) {
      setScrollX(Math.max(0, px - margin))
    }
  }, [playheadSecs])

  // Mouse hover for note tooltips
  const handleMouseMove = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    // Check if mouse is over any note
    for (const [trackIndex, track] of tracks.entries()) {
      if (mutedTracks.has(trackIndex)) continue
      for (const note of (track.notes || [])) {
        const x = keyWidth + note.start * pixelsPerSecond - scrollX
        const w = Math.max(2, (note.end - note.start) * pixelsPerSecond)
        const y = (maxPitch - note.pitch) * noteHeight - scrollY

        if (mx >= x && mx <= x + w && my >= y && my <= y + noteHeight) {
          setHoveredNote({ ...note, _x: mx, _y: my })
          return
        }
      }
    }
    setHoveredNote(null)
  }, [tracks, mutedTracks, scrollX, scrollY, maxPitch, noteHeight])

  // Scroll
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    if (e.shiftKey) {
      setScrollX((s) => Math.max(0, s + e.deltaY))
    } else {
      setScrollY((s) => Math.max(0, s + e.deltaY))
    }
  }, [])

  return (
    <div ref={containerRef} className="w-full">
      <canvas
        ref={canvasRef}
        style={{ width: canvasWidth, height }}
        className="rounded-lg cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredNote(null)}
        onWheel={handleWheel}
      />
    </div>
  )
}
