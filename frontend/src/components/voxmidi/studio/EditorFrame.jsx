import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useStudio } from '@/lib/studio/StudioContext'
import TransportBar from './TransportBar'
import AskRail from './AskRail'
import ExportDialog from './ExportDialog'

// Full-bleed frame for the editor screens (song, drums, piano roll): transport
// on top, the Ask rail on the right. The negative margin cancels the
// SidebarLayout content padding so the editors can use the whole panel.
export default function EditorFrame({ children }) {
  const { project } = useStudio()
  const [askOpen, setAskOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1280)
  const [exporting, setExporting] = useState(false)

  if (!project) return <Navigate to="/describe" replace />

  return (
    <div className="-m-6 lg:-m-10 flex flex-col h-[calc(100svh-3.5rem)] lg:h-[calc(100svh-1rem)] overflow-hidden lg:rounded-lg">
      <TransportBar onExport={() => setExporting(true)} onToggleAsk={() => setAskOpen((v) => !v)} askOpen={askOpen} />
      <div className="flex-1 min-h-0 flex relative">
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">{children}</div>
        {askOpen && (
          <AskRail
            onClose={() => setAskOpen(false)}
            className="w-[322px] flex-none max-lg:absolute max-lg:inset-x-0 max-lg:bottom-0 max-lg:w-auto max-lg:h-[70%] max-lg:z-20 max-lg:border-l-0 max-lg:border-t max-lg:rounded-t-xl max-lg:shadow-xl"
          />
        )}
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </div>
  )
}
