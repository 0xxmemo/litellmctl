import React, { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useAuth } from '@/hooks/useAuth'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { TierModelSelector } from '@/components/ModelSelector'
import { useAppContext } from '@/context/AppContext'
import { 
  User, 
  Palette, 
  Mail,
  LogOut,
  Loader2,
  Layers
} from 'lucide-react'

const ROLE_BADGE_VARIANT: Record<string, 'destructive' | 'default' | 'secondary' | 'outline'> = {
  admin: 'destructive',
  user: 'default',
  guest: 'secondary',
}

export function SettingsPanel() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const { config } = useAppContext()
  const [loggingOut, setLoggingOut] = useState(false)
  const [tierAliasMap, setTierAliasMap] = useState<Record<string, string> | null>(null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null)

  // Initialize profile with actual user data
  const [profile, setProfile] = useState({
    name: '',
    email: '',
    company: '',
  })

  // Sync profile when user data loads
  React.useEffect(() => {
    if (user?.email) {
      setProfile({
        name: user.name || '',
        email: user.email,
        company: user.company || '',
      })
    }
  }, [user?.email, user?.name, user?.company])

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch {
      // best-effort
    } finally {
      navigate({ to: '/auth' })
    }
  }

  // Theme state with localStorage persistence
  const [selectedTheme, setSelectedTheme] = useState<'light' | 'dark' | 'system'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme') as 'light' | 'dark' | 'system' | null
      return saved || 'dark'
    }
    return 'dark'
  })

  // Apply theme to document
  const applyTheme = (theme: 'light' | 'dark' | 'system') => {
    setSelectedTheme(theme)
    localStorage.setItem('theme', theme)
    
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    
    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      root.classList.add(systemTheme)
    } else {
      root.classList.add(theme)
    }
  }

  // Sync theme on mount and listen for system changes
  React.useEffect(() => {
    // Apply saved theme on mount
    const saved = localStorage.getItem('theme') as 'light' | 'dark' | 'system' | null
    if (saved) {
      applyTheme(saved)
    }

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => {
      if (selectedTheme === 'system') {
        const systemTheme = mediaQuery.matches ? 'dark' : 'light'
        const root = document.documentElement
        root.classList.remove('light', 'dark')
        root.classList.add(systemTheme)
      }
    }
    
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    setSavingProfile(true)
    setMessage(null)
    try {
      const res = await fetch('/api/user/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(profile),
      })
      if (res.ok) {
        setMessage({ type: 'success', text: 'Profile updated successfully' })
      } else {
        const data = await res.json()
        setMessage({ type: 'error', text: data.error || 'Failed to update profile' })
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to update profile' })
    } finally {
      setSavingProfile(false)
      setTimeout(() => setMessage(null), 3000)
    }
  }

  // ── Model Overrides ─────────────────────────────────────────────────────────
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [loadingOverrides, setLoadingOverrides] = useState(true)
  const [savingOverrides, setSavingOverrides] = useState(false)
  const [overridesMessage, setOverridesMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    fetch('/api/user/model-overrides', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setOverrides(data.model_overrides || {}))
      .catch(() => {})
      .finally(() => setLoadingOverrides(false))
  }, [])

  // Load tier aliases from non-admin endpoint (works for all authenticated users)
  useEffect(() => {
    fetch('/api/config/aliases', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setTierAliasMap(data.model_group_alias || {}))
      .catch(() => setTierAliasMap({}))
  }, [])

  const handleSaveOverrides = async () => {
    setSavingOverrides(true)
    setOverridesMessage(null)
    try {
      // Strip empty strings (= "use default alias") — only send actual overrides
      const payload: Record<string, string> = {}
      for (const [k, v] of Object.entries(overrides)) {
        if (v && v.trim()) payload[k] = v
      }
      const res = await fetch('/api/user/model-overrides', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (res.ok) {
        setOverrides(data.model_overrides || {})
        setOverridesMessage({ type: 'success', text: 'Model overrides saved' })
      } else {
        setOverridesMessage({ type: 'error', text: data.error || 'Failed to save overrides' })
      }
    } catch {
      setOverridesMessage({ type: 'error', text: 'Failed to save overrides' })
    } finally {
      setSavingOverrides(false)
      setTimeout(() => setOverridesMessage(null), 3000)
    }
  }

  // Dynamic tier aliases — prefer dedicated non-admin endpoint, fall back to config (admin only)
  const rs = config?.router_settings as any
  const configAlias: Record<string, string> = rs?.model_group_alias ?? config?.model_group_alias ?? {}
  const modelGroupAlias: Record<string, string> = tierAliasMap ?? configAlias
  const tierAliases = Object.keys(modelGroupAlias)
  const aliasesLoading = tierAliasMap === null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold">Settings</h2>
        <p className="text-muted-foreground">Manage your account and preferences</p>
      </div>

      {/* Profile Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <User className="h-5 w-5" />
              <CardTitle>Profile</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : user?.role ? (
                <Badge variant={ROLE_BADGE_VARIANT[user.role] ?? 'secondary'}>
                  {user.role}
                </Badge>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={handleLogout}
                disabled={loggingOut}
                className="flex items-center gap-1.5"
              >
                {loggingOut ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogOut className="h-4 w-4" />
                )}
                Logout
              </Button>
            </div>
          </div>
          <CardDescription>Update your personal information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {message && (
            <div className={`p-3 rounded-md text-sm ${
              message.type === 'success' 
                ? 'bg-green-500/10 text-green-500 border border-green-500/20' 
                : 'bg-red-500/10 text-red-500 border border-red-500/20'
            }`}>
              {message.text}
            </div>
          )}
          
          {/* Current email display */}
          {!loading && user?.email && (
            <div className="flex items-center gap-2 px-3 py-2 bg-muted rounded-md text-sm">
              <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="font-medium">{user.email}</span>
            </div>
          )}
          <form onSubmit={handleSaveProfile} autoComplete="on">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Name</label>
                <Input
                  name="name"
                  autoComplete="name"
                  value={profile.name}
                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Email</label>
                <Input
                  type="email"
                  name="email"
                  autoComplete="email"
                  value={profile.email}
                  onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium">Company</label>
                <Input
                  name="company"
                  autoComplete="organization"
                  value={profile.company}
                  onChange={(e) => setProfile({ ...profile, company: e.target.value })}
                />
              </div>
            </div>
            <Button type="submit" disabled={savingProfile} className="mt-4">
              {savingProfile ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Model Overrides */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            <CardTitle>Model Overrides</CardTitle>
          </div>
          <CardDescription>
            Map tier aliases (
            {tierAliases.length > 0
              ? tierAliases.map((alias, i) => (
                  <React.Fragment key={alias}>
                    {i > 0 && ', '}
                    <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">{alias}</code>
                  </React.Fragment>
                ))
              : <span className="text-muted-foreground text-xs">loading…</span>
            }) to specific models. Applies to all your API keys.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {overridesMessage && (
            <div className={`p-3 rounded-md text-sm ${
              overridesMessage.type === 'success'
                ? 'bg-green-500/10 text-green-500 border border-green-500/20'
                : 'bg-red-500/10 text-red-500 border border-red-500/20'
            }`}>
              {overridesMessage.text}
            </div>
          )}

          {loadingOverrides ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading overrides…
            </div>
          ) : aliasesLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading tier aliases…
            </div>
          ) : tierAliases.length === 0 ? (
            <div className="text-muted-foreground text-sm">
              No tier aliases configured. Contact your admin.
            </div>
          ) : (
            <div className="space-y-4">
              {tierAliases.map((alias) => (
                <div key={alias} className="space-y-1.5">
                  <div>
                    <label className="text-sm font-medium font-mono">{alias}</label>
                    <p className="text-xs text-muted-foreground">
                      Override for <code className="font-mono">{alias}</code> tier alias
                      {modelGroupAlias[alias] ? ` → ${modelGroupAlias[alias]}` : ''}
                    </p>
                  </div>
                  <TierModelSelector
                    value={overrides[alias]}
                    defaultAlias={alias}
                    onChange={(val) =>
                      setOverrides((prev) => ({
                        ...prev,
                        [alias]: val || undefined,
                      }))
                    }
                  />
                  {overrides[alias] && (
                    <p className="text-xs text-blue-400 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block" />
                      Override active: <span className="font-mono">{overrides[alias]}</span>
                    </p>
                  )}
                </div>
              ))}

              <div className="flex items-center gap-3 pt-2">
                <Button onClick={handleSaveOverrides} disabled={savingOverrides}>
                  {savingOverrides ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    'Save Overrides'
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setOverrides({})}
                  disabled={savingOverrides}
                >
                  Reset to Defaults
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Theme Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Palette className="h-5 w-5" />
            <CardTitle>Appearance</CardTitle>
          </div>
          <CardDescription>Customize how the dashboard looks</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <button 
              className={cn(
                "group relative rounded-lg border p-4 hover:bg-accent transition-colors",
                selectedTheme === 'light' && 'ring-2 ring-blue-500 border-blue-500'
              )}
              onClick={() => applyTheme('light')}
            >
              <div className="mb-2 h-20 w-full rounded bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-blue-950 dark:to-indigo-950" />
              <p className="text-sm font-medium">Light</p>
              <p className="text-xs text-muted-foreground">Always light mode</p>
            </button>
            <button 
              className={cn(
                "group relative rounded-lg border p-4 hover:bg-accent transition-colors",
                selectedTheme === 'dark' && 'ring-2 ring-blue-500 border-blue-500'
              )}
              onClick={() => applyTheme('dark')}
            >
              <div className="mb-2 h-20 w-full rounded bg-gradient-to-br from-gray-900 to-gray-950" />
              <p className="text-sm font-medium">Dark</p>
              <p className="text-xs text-muted-foreground">Always dark mode</p>
            </button>
            <button 
              className={cn(
                "group relative rounded-lg border p-4 hover:bg-accent transition-colors",
                selectedTheme === 'system' && 'ring-2 ring-blue-500 border-blue-500'
              )}
              onClick={() => applyTheme('system')}
            >
              <div className="mb-2 h-20 w-full rounded bg-gradient-to-br from-blue-50 to-gray-900" />
              <p className="text-sm font-medium">System</p>
              <p className="text-xs text-muted-foreground">Follow system preference</p>
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
