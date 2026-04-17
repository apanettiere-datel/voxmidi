// Auth-aware fetch — context-based to keep hooks rules clean.

import { createContext, useContext, useCallback } from 'react'
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

  const authFetch = useCallback(
    async (url, options = {}) => {
      // Don't act until Clerk has finished loading
      if (!isLoaded) {
        throw new Error('Auth loading — please wait')
      }

      // Clerk says user is not signed in → redirect once
      if (!isSignedIn) {
        console.warn('[authFetch] Not signed in — redirecting to /sign-in')
        navigate('/sign-in')
        throw new Error('Not signed in')
      }

      let token = null
      try {
        token = await getToken()
        console.log(`[authFetch] Token obtained (${url}): ${token ? token.slice(0, 40) + '...' : 'NULL'}`)
      } catch (e) {
        console.error('[authFetch] getToken() threw:', e)
      }

      if (!token) {
        // Clerk says isSignedIn=true but no token — usually a brief timing issue during session init.
        // Do NOT redirect (would cause infinite loop). Throw so caller can retry.
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
        // Log the 401 but do NOT auto-redirect — that causes infinite loops when JWT
        // verification fails on the backend. Let the calling code handle the error.
        console.error(`[authFetch] 401 from ${url} — token may be rejected by backend. Check CLERK_SECRET_KEY / JWKS config.`)
      }

      return response
    },
    [getToken, isSignedIn, isLoaded, navigate]
  )

  return <AuthFetchContext.Provider value={authFetch}>{children}</AuthFetchContext.Provider>
}

export function AuthFetchProvider({ children }) {
  if (!CLERK_KEY) {
    return <AuthFetchContext.Provider value={fetch.bind(window)}>{children}</AuthFetchContext.Provider>
  }
  return <ClerkFetchProvider>{children}</ClerkFetchProvider>
}
