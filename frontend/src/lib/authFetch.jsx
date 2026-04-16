// Auth-aware fetch — context-based to keep hooks rules clean.
// Usage: wrap tree in <AuthFetchProvider>, then call useAuthFetch() anywhere.

import { createContext, useContext, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'

const AuthFetchContext = createContext(null)

export function useAuthFetch() {
  const fn = useContext(AuthFetchContext)
  return fn || fetch.bind(window)
}

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// Only mounted when ClerkProvider is in tree — safe to call useAuth()
function ClerkFetchProvider({ children }) {
  const { getToken } = useAuth()

  const authFetch = useCallback(
    async (url, options = {}) => {
      let token = null
      try { token = await getToken() } catch {}
      return fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
    },
    [getToken]
  )

  return <AuthFetchContext.Provider value={authFetch}>{children}</AuthFetchContext.Provider>
}

export function AuthFetchProvider({ children }) {
  if (!CLERK_KEY) {
    // Dev mode: plain fetch, no auth headers needed
    return <AuthFetchContext.Provider value={fetch.bind(window)}>{children}</AuthFetchContext.Provider>
  }
  return <ClerkFetchProvider>{children}</ClerkFetchProvider>
}
