import { SignIn } from '@clerk/clerk-react'

export default function SignInPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 px-4 py-12">
      <div className="mb-8 text-center">
        <div className="flex items-center justify-center gap-3 mb-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600">
            <span className="text-white text-lg font-bold">♪</span>
          </div>
          <span className="text-2xl font-bold text-white tracking-tight">VoxMIDI</span>
        </div>
        <p className="text-zinc-400 text-sm">Turn your voice into editable MIDI</p>
      </div>
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        appearance={{
          variables: {
            colorPrimary: '#4f46e5',
            colorBackground: '#18181b',
            colorText: '#f4f4f5',
            colorTextSecondary: '#a1a1aa',
            colorInputBackground: '#27272a',
            colorInputText: '#f4f4f5',
            borderRadius: '0.75rem',
          },
          elements: {
            card: 'shadow-xl border border-zinc-800',
            headerTitle: 'text-white',
            headerSubtitle: 'text-zinc-400',
            socialButtonsBlockButton: 'border-zinc-700 text-zinc-300 hover:bg-zinc-800',
            formFieldInput: 'bg-zinc-800 border-zinc-700 text-white',
            footerActionLink: 'text-indigo-400 hover:text-indigo-300',
          },
        }}
      />
    </div>
  )
}
