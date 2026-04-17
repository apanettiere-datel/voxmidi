// Auth-aware fetch — context-based to keep hooks rules clean.

import { createContext, useContext, useCallback, useRef, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate } from 'react-router-dom'

const AuthFetchContext = createContext(null)

export function useAuthFetch() {
  const fn = useContext(AuthFetchContext)
  return fn || fetch.bind(window)
}

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

function ClerkFetchProvider({ children }) {
  const { getToken, isSignedIn, isLoaded } = useAuth()
  const navigate = useNavigate()

  // Keep a ref to the latest auth state so the authFetch function itself never
  // changes identity. Stable identity prevents cascading useEffect re-fires in
  // UsageBadge, JobsContext polling, etc.
  const stateRef = useRef({ getToken, isSignedIn, isLoaded, navigate })
  useEffect(() => {
    stateRef.current = { getToken, isSignedIn, isLoaded, navigate }
  })

  const authFetch = useCallback(
    async (url, options = {}) => {
      const { getToken: gt, isSignedIn: si, isLoaded: il, navigate: nav } = stateRef.current

      if (!il) throw new Error('Auth loading — please wait')

      if (!si) {
        console.warn('[authFetch] Not signed in — redirecting to /sign-in')
        nav('/sign-in')
        throw new Error('Not signed in')
      }

      let token = null
      try {
        token = await gt()
      } catch (e) {
        console.error('[authFetch] getToken() threw:', e)
      }

      if (!token) {
        console.error('[authFetch] isSignedIn=true but getToken() returned null — session loading?')
        throw new Error('Auth token unavailable — please try again')
      }

      const response = await fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        console.error(`[authFetch] 401 from ${url} — token may be rejected by backend.`)
      }

      return response
    },
    [] // stable identity — never changes, always reads latest state via ref
  )

  return <AuthFetchContext.Provider value={authFetch}>{children}</AuthFetchContext.Provider>
}

export function AuthFetchProvider({ children }) {
  if (!CLERK_KEY) {
    return <AuthFetchContext.Provider value={fetch.bind(window)}>{children}</AuthFetchContext.Provider>
  }
  return <ClerkFetchProvider>{children}</ClerkFetchProvider>
}
