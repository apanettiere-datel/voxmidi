// Auth-aware fetch — context-based to keep hooks rules clean.
// Usage: wrap tree in <AuthFetchProvider>, then call useAuthFetch() anywhere.

import { createContext, useContext, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate } from 'react-router-dom'

const AuthFetchContext = createContext(null)

export function useAuthFetch() {
  const fn = useContext(AuthFetchContext)
  return fn || fetch.bind(window)
}

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// Only mounted when ClerkProvider is in tree — safe to call useAuth()
function ClerkFetchProvider({ children }) {
  const { getToken } = useAuth()
  const navigate = useNavigate()

  const authFetch = useCallback(
    async (url, options = {}) => {
      let token = null
      try {
        token = await getToken()
      } catch (e) {
        console.error('[authFetch] getToken failed:', e)
      }

      if (!token) {
        navigate('/sign-in')
        throw new Error('Not authenticated')
      }

      const response = await fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        navigate('/sign-in')
        throw new Error('Session expired — please sign in again')
      }

      return response
    },
    [getToken, navigate]
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
