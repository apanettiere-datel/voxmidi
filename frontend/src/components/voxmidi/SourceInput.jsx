import { useState, useRef } from 'react'

export default function SourceInput({ url, onUrlChange }) {
  const [dragOver, setDragOver] = useState(false)
  const [uploadedFile, setUploadedFile] = useState(null)
  const fileInputRef = useRef(null)

  function handleFileDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file && file.type.startsWith('audio/')) {
      setUploadedFile(file)
      onUrlChange(`file://${file.name}`)
    }
  }

  function handleFileSelect(e) {
    const file = e.target.files[0]
    if (file) {
      setUploadedFile(file)
      onUrlChange(`file://${file.name}`)
    }
  }

  return (
    <div className="space-y-4">
      {/* URL input */}
      <div>
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          YouTube URL or audio link
        </label>
        <div className="mt-1 flex gap-2">
          <input
            type="url"
            value={url.startsWith('file://') ? '' : url}
            onChange={(e) => {
              setUploadedFile(null)
              onUrlChange(e.target.value)
            }}
            placeholder="https://www.youtube.com/watch?v=..."
            className="block flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-white dark:placeholder:text-zinc-500"
          />
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Paste a YouTube URL with a timestamp to extract a specific section (e.g., ?t=835s)
        </p>
      </div>

      {/* Divider */}
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-zinc-200 dark:border-zinc-700" />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="bg-white px-3 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">or upload a file</span>
        </div>
      </div>

      {/* File upload drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleFileDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition ${
          dragOver
            ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/20'
            : 'border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          onChange={handleFileSelect}
          className="hidden"
        />
        {uploadedFile ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-zinc-900 dark:text-white">{uploadedFile.name}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {(uploadedFile.size / 1024 / 1024).toFixed(1)} MB
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Drop an audio file here or click to browse
            </p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              MP3, WAV, FLAC, OGG, M4A
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
