import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { MusicalNoteIcon, MicrophoneIcon, FolderIcon, Cog6ToothIcon, WrenchScrewdriverIcon, BoltIcon, Squares2X2Icon, SparklesIcon, QueueListIcon, PaintBrushIcon } from '@heroicons/react/20/solid'
import { SidebarLayout } from '@/components/catalyst/sidebar-layout'
import { Sidebar, SidebarBody, SidebarFooter, SidebarHeader, SidebarHeading, SidebarItem, SidebarLabel, SidebarSection } from '@/components/catalyst/sidebar'
import { Navbar, NavbarSpacer } from '@/components/catalyst/navbar'
import { SignedIn, SignedOut, RedirectToSignIn, UserButton, useUser, useClerk } from '@clerk/clerk-react'
import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

import GeneratePage from '@/pages/GeneratePage'
import JamPage from '@/pages/JamPage'
import DrumGridPage from '@/pages/DrumGridPage'
import MidiWorkshopPage from '@/pages/MidiWorkshopPage'
import LibraryPage from '@/pages/LibraryPage'
import SettingsPage from '@/pages/SettingsPage'
import SignInPage from '@/pages/SignInPage'
import SignUpPage from '@/pages/SignUpPage'
import SharePage from '@/pages/SharePage'
import DescribePage from '@/pages/studio/DescribePage'
import SongPage from '@/pages/studio/SongPage'
import StudioDrumsPage from '@/pages/studio/StudioDrumsPage'
import PianoRollPage from '@/pages/studio/PianoRollPage'
import RecordPage from '@/pages/studio/RecordPage'
import RiffPage from '@/pages/studio/RiffPage'
import TapPage from '@/pages/studio/TapPage'
import PlanCard from '@/components/voxmidi/studio/PlanCard'
import { StudioProvider, useStudio } from '@/lib/studio/StudioContext'
import { totalBars } from '@/lib/studio/project'
import { JobsNotificationBar } from '@/lib/JobsContext'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

const startNav = [
  { name: 'Describe a beat', href: '/describe', icon: SparklesIcon },
  { name: 'Record a riff', href: '/record', icon: MicrophoneIcon },
  { name: 'Tap a groove', href: '/tap', icon: Squares2X2Icon },
]

const songNav = [
  { name: 'Song', href: '/song', icon: QueueListIcon, exact: true },
  { name: 'Drums', href: '/song/drums', icon: Squares2X2Icon },
  { name: 'Piano roll', href: '/song/roll', icon: MusicalNoteIcon },
  { name: 'From a riff', href: '/riff', icon: PaintBrushIcon },
]

const navigation = [
  { name: 'Song Generator', href: '/generate', icon: MusicalNoteIcon },
  { name: 'Jam', href: '/jam', icon: BoltIcon },
  { name: 'Drum Grid', href: '/drums', icon: Squares2X2Icon },
  { name: 'MIDI Workshop', href: '/midi', icon: WrenchScrewdriverIcon },
  { name: 'Library', href: '/library', icon: FolderIcon },
  { name: 'Settings', href: '/settings', icon: Cog6ToothIcon },
]

// Only safe to call useUser()/useClerk() when ClerkProvider is in tree
function ClerkSidebarFooter() {
  const { user } = useUser()
  const { signOut } = useClerk()
  const navigate = useNavigate()

  const handleSignOut = useCallback(async () => {
    await signOut()
    navigate('/sign-in')
  }, [signOut, navigate])

  if (!user) return null

  const displayName = user.firstName || user.emailAddresses?.[0]?.emailAddress || 'Account'

  return (
    <SidebarFooter>
      <SidebarSection>
        <div className="flex items-center gap-2 px-2 py-2">
          <UserButton afterSignOutUrl="/sign-in" />
          <span className="text-sm text-zinc-700 dark:text-zinc-300 truncate flex-1 min-w-0">
            {displayName}
          </span>
        </div>
        <button
          onClick={handleSignOut}
          className="w-full mt-1 rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-red-600 dark:hover:text-red-400 transition text-left"
        >
          Sign out
        </button>
      </SidebarSection>
    </SidebarFooter>
  )
}

function NavItems({ items, pathname }) {
  return items.map((item) => {
    const isCurrent = item.exact ? pathname === item.href : pathname.startsWith(item.href)
    return (
      <SidebarItem key={item.name} href={item.href} current={isCurrent}>
        <item.icon data-slot="icon" />
        <SidebarLabel>{item.name}</SidebarLabel>
        {item.tag && <span className="ml-auto font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">{item.tag}</span>}
      </SidebarItem>
    )
  })
}

function AppLayout({ children }) {
  const location = useLocation()
  const { project } = useStudio()
  const song = project && songNav.map((n) => (n.href === '/song' ? { ...n, tag: `${totalBars(project.sections)} bars` } : n))

  return (
    <SidebarLayout
      sidebar={
        <Sidebar>
          <SidebarHeader>
            <SidebarItem href="/">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 shrink-0">
                <MusicalNoteIcon className="h-5 w-5 text-white" />
              </div>
              <SidebarLabel className="font-semibold">VoxMIDI</SidebarLabel>
            </SidebarItem>
          </SidebarHeader>
          <SidebarBody>
            <SidebarSection>
              <SidebarHeading>Start something</SidebarHeading>
              <NavItems items={startNav} pathname={location.pathname} />
            </SidebarSection>
            {song && (
              <SidebarSection>
                <SidebarHeading className="truncate">{project.name}</SidebarHeading>
                <NavItems items={song} pathname={location.pathname} />
              </SidebarSection>
            )}
            <SidebarSection>
              <SidebarHeading>Tools</SidebarHeading>
              <NavItems items={navigation} pathname={location.pathname} />
            </SidebarSection>
          </SidebarBody>
          <PlanCard />
          {CLERK_KEY && <ClerkSidebarFooter />}
        </Sidebar>
      }
      navbar={<Navbar><NavbarSpacer /></Navbar>}
    >
      {children}
    </SidebarLayout>
  )
}

function AppRoutes() {
  return (
    <StudioProvider>
      <AppLayout>
        <Routes>
          <Route path="/" element={<Navigate to="/generate" replace />} />
          <Route path="/generate" element={<GeneratePage />} />
          <Route path="/jam" element={<JamPage />} />
          <Route path="/drums" element={<DrumGridPage />} />
          <Route path="/midi" element={<MidiWorkshopPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/describe" element={<DescribePage />} />
          <Route path="/song" element={<SongPage />} />
          <Route path="/song/drums" element={<StudioDrumsPage />} />
          <Route path="/song/roll" element={<PianoRollPage />} />
          <Route path="/record" element={<RecordPage />} />
          <Route path="/riff" element={<RiffPage />} />
          <Route path="/tap" element={<TapPage />} />
        </Routes>
      </AppLayout>
    </StudioProvider>
  )
}

export default function App() {
  if (!CLERK_KEY) {
    return (
      <>
        <Routes>
          <Route path="/share/:jobId" element={<SharePage />} />
          <Route path="/*" element={<AppRoutes />} />
        </Routes>
        <JobsNotificationBar />
      </>
    )
  }

  return (
    <>
      <Routes>
        <Route path="/sign-in/*" element={<SignInPage />} />
        <Route path="/sign-up/*" element={<SignUpPage />} />
        <Route path="/share/:jobId" element={<SharePage />} />
        <Route
          path="/*"
          element={
            <>
              <SignedIn>
                <AppRoutes />
              </SignedIn>
              <SignedOut>
                <RedirectToSignIn />
              </SignedOut>
            </>
          }
        />
      </Routes>
      <JobsNotificationBar />
    </>
  )
}
