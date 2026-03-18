'use client'
import { useState } from 'react'
// import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

// Mock user data - in real app this would come from auth context/session
const MOCK_USER = {
  email: '0xmemo@pm.me',
  role: 'admin' as 'guest' | 'user' | 'admin'
}

export function Settings() {
  const [email, setEmail] = useState(MOCK_USER.email)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch('/api/settings/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email })
      }) as Response & { json: () => Promise<{ message?: string; error?: string }> }
      const data = await res.json()
      if (res.ok) {
        setMessage({ text: data.message || 'Profile updated!', ok: true })
      } else {
        setMessage({ text: data.error || 'Failed to save', ok: false })
      }
    } catch {
      setMessage({ text: 'Network error — please try again', ok: false })
    } finally {
      setSaving(false)
    }
  }

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      })
      window.location.href = '/login'
    } catch {
      setMessage({ text: 'Failed to logout', ok: false })
    }
  }

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'admin':
        return 'destructive'
      case 'user':
        return 'default'
      default:
        return 'secondary'
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Settings</h1>

      <Card className="p-6">
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-xl font-semibold">Profile</h2>
          <Badge variant={getRoleBadgeColor(MOCK_USER.role)}>
            {MOCK_USER.role}
          </Badge>
        </div>
        
        <div className="mb-4 p-3 bg-muted rounded-md">
          <p className="text-sm font-medium text-muted-foreground">Current Email</p>
          <p className="text-base font-semibold">{MOCK_USER.email}</p>
        </div>
        
        <form onSubmit={handleSaveProfile} className="space-y-4" autoComplete="on">
          <div>
            <label className="block text-sm font-medium mb-2">Update Email</label>
            <input
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border rounded-md bg-background"
              placeholder="your@email.com"
            />
          </div>

          {message && (
            <p className={`text-sm ${message.ok ? 'text-green-500' : 'text-red-500'}`}>
              {message.text}
            </p>
          )}

          <div className="flex gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button variant="outline" onClick={handleLogout}>
              Logout
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
