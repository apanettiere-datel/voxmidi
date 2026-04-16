import { useState, useEffect } from 'react'
import { useUser } from '@clerk/clerk-react'
import { getSettings, saveSettings } from '@/lib/api'
import { useAuthFetch } from '@/lib/authFetch'
import { Heading } from '@/components/catalyst/heading'
import { Text } from '@/components/catalyst/text'
import { Button } from '@/components/catalyst/button'
import { Field, FieldGroup, Label, Description } from '@/components/catalyst/fieldset'
import { Input } from '@/components/catalyst/input'
import { Select } from '@/components/catalyst/select'
import { Divider } from '@/components/catalyst/divider'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// Only mounted when Clerk is active — safe to call useUser()
function AccountSection() {
  const { user } = useUser()
  if (!user) return null
  const email = user.emailAddresses?.[0]?.emailAddress || '—'
  const since = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'
  return (
    <div>
      <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Account</h2>
      <Divider className="mt-3 mb-6" />
      <dl className="space-y-3 text-sm">
        <div className="flex gap-4">
          <dt className="w-28 text-zinc-500 dark:text-zinc-400 shrink-0">Name</dt>
          <dd className="text-zinc-900 dark:text-white">{user.fullName || user.firstName || '—'}</dd>
        </div>
        <div className="flex gap-4">
          <dt className="w-28 text-zinc-500 dark:text-zinc-400 shrink-0">Email</dt>
          <dd className="text-zinc-900 dark:text-white">{email}</dd>
        </div>
        <div className="flex gap-4">
          <dt className="w-28 text-zinc-500 dark:text-zinc-400 shrink-0">Member since</dt>
          <dd className="text-zinc-900 dark:text-white">{since}</dd>
        </div>
      </dl>
    </div>
  )
}

function UsageSection({ authFetch }) {
  const [usage, setUsage] = useState(null)

  useEffect(() => {
    authFetch('/api/usage')
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setUsage(d))
      .catch(() => {})
  }, [authFetch])

  return (
    <div>
      <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Usage</h2>
      <Divider className="mt-3 mb-6" />
      {usage ? (
        <dl className="space-y-3 text-sm">
          <div className="flex gap-4">
            <dt className="w-28 text-zinc-500 dark:text-zinc-400 shrink-0">This month</dt>
            <dd className="text-zinc-900 dark:text-white font-mono">{usage.used} / {usage.limit} generations</dd>
          </div>
          <div className="flex gap-4">
            <dt className="w-28 text-zinc-500 dark:text-zinc-400 shrink-0">Remaining</dt>
            <dd className="text-zinc-900 dark:text-white font-mono">{usage.remaining}</dd>
          </div>
          <div className="flex gap-4">
            <dt className="w-28 text-zinc-500 dark:text-zinc-400 shrink-0">Resets</dt>
            <dd className="text-zinc-900 dark:text-white">{usage.reset_date}</dd>
          </div>
          <div className="mt-2">
            <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2">
              <div
                className="bg-indigo-600 h-2 rounded-full transition-all"
                style={{ width: `${Math.min((usage.used / usage.limit) * 100, 100)}%` }}
              />
            </div>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-zinc-400 dark:text-zinc-500">Loading usage...</p>
      )}
    </div>
  )
}

export default function SettingsPage() {
  const authFetch = useAuthFetch()
  const [settings, setSettings] = useState(getSettings())
  const [saved, setSaved] = useState(false)

  useEffect(() => { setSettings(getSettings()) }, [])

  function handleSave() {
    saveSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="space-y-10 max-w-2xl">
      <div>
        <Heading>Settings</Heading>
        <Text>Manage your account, usage, and export preferences.</Text>
      </div>

      {/* Account — only shown when Clerk is active */}
      {CLERK_KEY && <AccountSection />}

      {/* Usage */}
      <UsageSection authFetch={authFetch} />

      {/* Export Defaults */}
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Export Defaults</h2>
        <Divider className="mt-3 mb-6" />
        <FieldGroup>
          <Field>
            <Label>Default DAW</Label>
            <Description>Shown in DAW-specific import instructions after generation.</Description>
            <Select value={settings.defaultDaw} onChange={e => setSettings(s => ({ ...s, defaultDaw: e.target.value }))}>
              <option value="garageband">GarageBand</option>
              <option value="ableton">Ableton Live</option>
              <option value="flstudio">FL Studio</option>
              <option value="logic">Logic Pro</option>
              <option value="cubase">Cubase</option>
            </Select>
          </Field>
          <Field>
            <Label>MIDI Resolution</Label>
            <Description>Ticks per quarter note. 480 is standard.</Description>
            <Select value={settings.midiResolution} onChange={e => setSettings(s => ({ ...s, midiResolution: e.target.value }))}>
              <option value="480">480 ticks/beat (standard)</option>
              <option value="960">960 ticks/beat (high precision)</option>
              <option value="240">240 ticks/beat (compact)</option>
            </Select>
          </Field>
        </FieldGroup>
      </div>

      {/* About */}
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-white">About</h2>
        <Divider className="mt-3 mb-6" />
        <dl className="space-y-3 text-sm">
          <div className="flex gap-4">
            <dt className="w-28 text-zinc-500 dark:text-zinc-400 shrink-0">Version</dt>
            <dd className="text-zinc-900 dark:text-white font-mono">0.2.0</dd>
          </div>
          <div className="flex gap-4">
            <dt className="w-28 text-zinc-500 dark:text-zinc-400 shrink-0">GitHub</dt>
            <dd>
              <a href="https://github.com" className="text-indigo-600 dark:text-indigo-400 hover:underline text-sm">
                github.com/voxmidi
              </a>
            </dd>
          </div>
        </dl>
      </div>

      <div className="flex items-center gap-4 pt-4">
        <Button color="indigo" onClick={handleSave}>Save Settings</Button>
        {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">✓ Saved</span>}
      </div>
    </div>
  )
}
