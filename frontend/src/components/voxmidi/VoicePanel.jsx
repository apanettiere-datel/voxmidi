import { useState, useRef } from 'react'
import AudioRecorder from './AudioRecorder'

const AUTOTUNE_LABELS = ['Natural', 'Subtle', 'Moderate', 'Heavy', 'T-Pain']
const REVERB_LABELS = ['Dry', 'Room', 'Hall', 'Large Hall', 'Cathedral']

function autotuneLabel(v) { return AUTOTUNE_LABELS[Math.round(v / 25)] || 'Natural' }
function reverbLabel(v) { return REVERB_LABELS[Math.round(v / 25)] || 'Dry' }

export default function VoicePanel({
  onHumBlob,       // (blob|null) => void
  onSingBlob,      // (blob|null) => void
  onUploadFile,    // (file|null, mode: 'reference'|'extract') => void
  onAutotuneChange,
  onReverbChange,
  onTabChange,     // (tab: 'hum'|'sing'|'upload') => void
  lyrics,
}) {
  const [tab, setTab] = useState('hum')
  const [autotune, setAutotune] = useState(0)
  const [reverb, setReverb] = useState(0)
  const [uploadedFile, setUploadedFile] = useState(null)
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState(null)
  const fileRef = useRef(null)

  function handleAutotuneChange(v) {
    setAutotune(v)
    onAutotuneChange?.(v)
  }

  function handleReverbChange(v) {
    setReverb(v)
    onReverbChange?.(v)
  }

  function handleUploadFile(f) {
    setUploadedFile(f)
    if (uploadPreviewUrl) URL.revokeObjectURL(uploadPreviewUrl)
    setUploadPreviewUrl(f ? URL.createObjectURL(f) : null)
  }

  const TABS = [
    { id: 'hum',    label: '🎵 Hum a Melody' },
    { id: 'sing',   label: '🎤 Sing Your Lyrics' },
    { id: 'upload', label: '📁 Upload Audio' },
  ]

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => { setTab(t.id); onTabChange?.(t.id) }}
            className={`flex-1 py-2.5 text-xs font-medium transition border-b-2 -mb-px ${
              tab === t.id
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-5">
        {/* TAB 1: Hum a Melody */}
        {tab === 'hum' && (
          <div className="space-y-3">
            <div className="rounded-lg bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900 px-4 py-3 text-sm text-indigo-800 dark:text-indigo-200">
              <p className="font-medium">🎵 Hum, whistle, or beatbox a melody</p>
              <p className="text-xs text-indigo-600 dark:text-indigo-300 mt-1">AI arranges a full track around your melody. No vocals in output.</p>
            </div>
            <AudioRecorder onRecordingComplete={(blob) => { onHumBlob?.(blob); onSingBlob?.(null) }} />
          </div>
        )}

        {/* TAB 2: Sing Your Lyrics */}
        {tab === 'sing' && (
          <div className="space-y-4">
            <div className="rounded-lg bg-purple-50 dark:bg-purple-950/30 border border-purple-100 dark:border-purple-900 px-4 py-3 text-sm text-purple-800 dark:text-purple-200">
              <p className="font-medium">🎤 Sing your lyrics</p>
              <p className="text-xs text-purple-600 dark:text-purple-300 mt-1">AI polishes your performance into a full track with your vocals.</p>
            </div>

            {!lyrics?.trim() && (
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                💡 Add lyrics first (via "Add Lyrics") so the AI can match your singing
              </div>
            )}

            <AudioRecorder onRecordingComplete={(blob) => { onSingBlob?.(blob); onHumBlob?.(null) }} />

            {/* Autotune slider */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Pitch Correction</label>
                <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">{autotuneLabel(autotune)} ({autotune}%)</span>
              </div>
              <input
                type="range" min={0} max={100} step={25} value={autotune}
                onChange={(e) => handleAutotuneChange(Number(e.target.value))}
                className="w-full accent-indigo-600"
              />
              <div className="flex justify-between text-xs text-zinc-400 mt-0.5">
                <span>Natural</span><span>T-Pain</span>
              </div>
            </div>

            {/* Reverb slider */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Reverb</label>
                <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">{reverbLabel(reverb)} ({reverb}%)</span>
              </div>
              <input
                type="range" min={0} max={100} step={25} value={reverb}
                onChange={(e) => handleReverbChange(Number(e.target.value))}
                className="w-full accent-indigo-600"
              />
              <div className="flex justify-between text-xs text-zinc-400 mt-0.5">
                <span>Dry</span><span>Cathedral</span>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: Upload Audio */}
        {tab === 'upload' && (
          <div className="space-y-4">
            {/* Drop zone */}
            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const f = e.dataTransfer.files[0]
                if (f) handleUploadFile(f)
              }}
              className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
                uploadedFile
                  ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/20'
                  : 'border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
              }`}
            >
              {uploadedFile ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">🎵 {uploadedFile.name}</p>
                  <p className="text-xs text-zinc-400">{(uploadedFile.size / 1048576).toFixed(1)} MB</p>
                  <button type="button" onClick={(e) => { e.stopPropagation(); handleUploadFile(null); onUploadFile?.(null, 'reference') }}
                    className="text-xs text-zinc-400 hover:text-red-500 underline">Remove</button>
                </div>
              ) : (
                <>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">Drop audio here or click to browse</p>
                  <p className="text-xs text-zinc-400 mt-1">MP3, WAV, FLAC, OGG, M4A</p>
                </>
              )}
            </div>
            <input ref={fileRef} type="file" accept="audio/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadFile(f) }} />

            {uploadPreviewUrl && (
              <audio controls src={uploadPreviewUrl} className="w-full h-9 rounded-lg" />
            )}

            {uploadedFile && (
              <div className="flex gap-2">
                <button type="button"
                  onClick={() => onUploadFile?.(uploadedFile, 'reference')}
                  className="flex-1 rounded-lg border border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 text-xs font-medium py-2.5 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition">
                  🎵 Use as melody reference
                </button>
                <button type="button"
                  onClick={() => onUploadFile?.(uploadedFile, 'extract')}
                  className="flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 text-xs font-medium py-2.5 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition">
                  🔪 Extract stems only
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
