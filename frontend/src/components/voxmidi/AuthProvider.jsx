import { ClerkProvider } from '@clerk/clerk-react'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

export default function AuthProvider({ children }) {
  if (!CLERK_KEY) {
    // Dev mode: no Clerk configured, render app directly
    return <>{children}</>
  }
  return (
    <ClerkProvider publishableKey={CLERK_KEY} afterSignOutUrl="/sign-in">
      {children}
    </ClerkProvider>
  )
}
