import { Routes, Route, useLocation } from 'react-router-dom'
import { MusicalNoteIcon, MicrophoneIcon, FolderIcon, LinkIcon, Cog6ToothIcon } from '@heroicons/react/20/solid'
import { SidebarLayout } from '@/components/catalyst/sidebar-layout'
import { Sidebar, SidebarBody, SidebarFooter, SidebarHeader, SidebarItem, SidebarLabel, SidebarSection } from '@/components/catalyst/sidebar'
import { Navbar, NavbarSpacer } from '@/components/catalyst/navbar'
import { SignedIn, SignedOut, RedirectToSignIn, UserButton, useUser } from '@clerk/clerk-react'
import { useState, useEffect } from 'react'

import CreatePage from '@/pages/CreatePage'
import LibraryPage from '@/pages/LibraryPage'
import SourcesPage from '@/pages/SourcesPage'
import SettingsPage from '@/pages/SettingsPage'
import SignInPage from '@/pages/SignInPage'
import SignUpPage from '@/pages/SignUpPage'
import SharePage from '@/pages/SharePage'
import { useAuthFetch } from '@/lib/authFetch'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

const navigation = [
  { name: 'Create', href: '/', icon: MicrophoneIcon },
  { name: 'Library', href: '/library', icon: FolderIcon },
  { name: 'Sources', href: '/sources', icon: LinkIcon },
  { name: 'Settings', href: '/settings', icon: Cog6ToothIcon },
]

function UsageBadge() {
  const authFetch = useAuthFetch()
  const [usage, setUsage] = useState(null)

  useEffect(() => {
    authFetch('/api/usage')
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setUsage(d))
      .catch(() => {})
  }, [authFetch])

  if (!usage) return null
  return (
    <span className="ml-1 text-xs text-zinc-400 dark:text-zinc-500 tabular-nums">
      {usage.used}/{usage.limit}
    </span>
  )
}

// Only safe to call useUser() when ClerkProvider is in tree
function ClerkSidebarFooter() {
  const { user } = useUser()
  if (!user) return null
  return (
    <SidebarFooter>
      <SidebarSection>
        <div className="flex items-center gap-3 px-2 py-2">
          <UserButton afterSignOutUrl="/sign-in" />
          <span className="text-sm text-zinc-700 dark:text-zinc-300 truncate flex-1">
            {user.firstName || user.emailAddresses?.[0]?.emailAddress || 'Account'}
          </span>
          <UsageBadge />
        </div>
      </SidebarSection>
    </SidebarFooter>
  )
}

function AppLayout({ children }) {
  const location = useLocation()

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
              {navigation.map((item) => {
                const isCurrent =
                  item.href === '/'
                    ? location.pathname === '/'
                    : location.pathname.startsWith(item.href)
                return (
                  <SidebarItem key={item.name} href={item.href} current={isCurrent}>
                    <item.icon data-slot="icon" />
                    <SidebarLabel>{item.name}</SidebarLabel>
                  </SidebarItem>
                )
              })}
            </SidebarSection>
          </SidebarBody>
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
    <AppLayout>
      <Routes>
        <Route path="/" element={<CreatePage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/sources" element={<SourcesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </AppLayout>
  )
}

export default function App() {
  if (!CLERK_KEY) {
    return (
      <Routes>
        <Route path="/share/:jobId" element={<SharePage />} />
        <Route path="/*" element={<AppRoutes />} />
      </Routes>
    )
  }

  return (
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
  )
}
