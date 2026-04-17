import { useState, useRef } from 'react'
import AudioRecorder from './AudioRecorder'

export default function VoicePanel({
  onHumBlob,       // (blob|null) => void
  onUploadFile,    // (file|null, mode: 'reference'|'extract') => void
  onTabChange,     // (tab: 'hum'|'upload') => void
}) {
  const [tab, setTab] = useState('hum')
  const [uploadedFile, setUploadedFile] = useState(null)
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState(null)
  const fileRef = useRef(null)

  function handleUploadFile(f) {
    setUploadedFile(f)
    if (uploadPreviewUrl) URL.revokeObjectURL(uploadPreviewUrl)
    setUploadPreviewUrl(f ? URL.createObjectURL(f) : null)
  }

  const TABS = [
    { id: 'hum',    label: '🎵 Hum a Melody' },
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
            <AudioRecorder onRecordingComplete={(blob) => { onHumBlob?.(blob) }} />
          </div>
        )}

        {/* TAB 2: Upload Audio */}
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
