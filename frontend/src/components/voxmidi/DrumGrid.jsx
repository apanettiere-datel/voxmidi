import { useRef } from 'react'

// Active-cell fill colors: one distinct color per track
const TRACK_COLORS = {
  kick:   '#818cf8', // indigo-400
  snare:  '#f472b6', // pink-400
  hat:    '#fbbf24', // amber-400
  clap:   '#34d399', // emerald-400
  tom:    '#22d3ee', // cyan-400
  shaker: '#fb923c', // orange-400
}

const TRACK_LABELS = {
  kick:   'Kick',
  snare:  'Snare',
  hat:    'Hi-hat',
  clap:   'Clap',
  tom:    'Tom',
  shaker: 'Shaker',
}

// Inactive cell colors
const CELL_OFF  = 'rgb(39,39,42)'  // zinc-800
const CELL_HEAD = 'rgba(255,255,255,0.14)'

export default function DrumGrid({ lanes, stepsTotal, stepsPerBeat, playheadStep, onToggle }) {
  const dragRef = useRef({ painting: false, paintValue: false })
  const barSteps = stepsPerBeat * 4

  function handlePointerDown(lane, e) {
    e.currentTarget.setPointerCapture(e.pointerId)
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-step]')
    if (!cell || cell.dataset.lane !== lane) return
    const idx = parseInt(cell.dataset.step, 10)
    const val = !(lanes[lane]?.[idx] ?? false)
    dragRef.current = { painting: true, paintValue: val }
    onToggle(lane, idx, val)
  }

  function handlePointerMove(lane, e) {
    if (!dragRef.current.painting) return
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-step]')
    if (!cell || cell.dataset.lane !== lane) return
    const idx = parseInt(cell.dataset.step, 10)
    onToggle(lane, idx, dragRef.current.paintValue)
  }

  function handlePointerUp() {
    dragRef.current.painting = false
  }

  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: `${stepsTotal * 22}px` }}>
        {Object.keys(lanes).map((lane) => (
          <div key={lane} className="flex items-center mb-1.5">
            {/* Lane label */}
            <div className="w-14 shrink-0 pr-2.5 text-right">
              <span className="text-xs font-medium text-zinc-400 tabular-nums select-none">
                {TRACK_LABELS[lane] ?? lane}
              </span>
            </div>

            {/* Cells */}
            <div
              className="flex flex-1 touch-none"
              style={{ userSelect: 'none' }}
              onPointerDown={(e) => handlePointerDown(lane, e)}
              onPointerMove={(e) => handlePointerMove(lane, e)}
              onPointerUp={handlePointerUp}
            >
              {Array.from({ length: stepsTotal }, (_, i) => {
                const isOn      = lanes[lane]?.[i] ?? false
                const isHead    = i === playheadStep
                // Gap sizing: bar gap > beat gap > step gap
                const ml =
                  i === 0            ? 0 :
                  i % barSteps === 0 ? 8 :
                  i % stepsPerBeat  === 0 ? 3 : 1

                return (
                  <div
                    key={i}
                    data-lane={lane}
                    data-step={i}
                    style={{
                      flex: '1 1 0',
                      height: '2rem',
                      borderRadius: '2px',
                      marginLeft: `${ml}px`,
                      cursor: 'pointer',
                      backgroundColor: isOn
                        ? (TRACK_COLORS[lane] ?? '#818cf8')
                        : isHead
                        ? CELL_HEAD
                        : CELL_OFF,
                      // Subtle brightness lift when cell is both on and playhead
                      filter: isOn && isHead ? 'brightness(1.3)' : undefined,
                      transition: 'background-color 0.04s',
                    }}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
