import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSources, saveSource, deleteSource } from '@/lib/api'
import { Heading } from '@/components/catalyst/heading'
import { Text } from '@/components/catalyst/text'
import { Button } from '@/components/catalyst/button'
import { Field, Label } from '@/components/catalyst/fieldset'
import { Input } from '@/components/catalyst/input'
import { Divider } from '@/components/catalyst/divider'

export default function SourcesPage() {
  const navigate = useNavigate()
  const [sources, setSources] = useState([])
  const [newUrl, setNewUrl] = useState('')
  const [inputError, setInputError] = useState('')

  useEffect(() => {
    setSources(getSources())
  }, [])

  function handleAdd() {
    if (!newUrl.trim()) {
      setInputError('Please enter a URL.')
      return
    }
    if (!newUrl.startsWith('http')) {
      setInputError('URL must start with http or https.')
      return
    }
    setInputError('')
    saveSource(newUrl.trim())
    setNewUrl('')
    setSources(getSources())
  }

  function handleDelete(id) {
    deleteSource(id)
    setSources(getSources())
  }

  function handleLoad(url) {
    sessionStorage.setItem('voxmidi_load_source', url)
    navigate('/')
  }

  return (
    <div className="space-y-8">
      <div>
        <Heading>Sources</Heading>
        <Text>Save YouTube URLs and audio sources for quick access.</Text>
      </div>

      {/* Add new source */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white mb-4">Add Source URL</h3>
        <div className="flex gap-3">
          <div className="flex-1">
            <Input
              type="url"
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=..."
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
            />
            {inputError && <p className="mt-1 text-xs text-red-600">{inputError}</p>}
          </div>
          <Button color="indigo" onClick={handleAdd}>Save</Button>
        </div>
      </div>

      <Divider />

      {/* Sources list */}
      {sources.length === 0 ? (
        <div className="text-center py-8">
          <Text>No saved sources yet. Add a YouTube URL above.</Text>
        </div>
      ) : (
        <div className="space-y-2">
          {sources.map(source => (
            <div key={source.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-900 dark:text-white truncate">{source.title}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">{new Date(source.date).toLocaleDateString()}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button plain onClick={() => handleLoad(source.url)}>Load in Create</Button>
                <Button plain onClick={() => handleDelete(source.id)}>
                  <span className="text-red-600 dark:text-red-400">Remove</span>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
