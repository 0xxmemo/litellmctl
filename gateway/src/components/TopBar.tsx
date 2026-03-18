'use client'
import { useState, useEffect } from 'react'
import { LogOut, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'

interface UserProfile {
  email: string
  role: 'admin' | 'user' | 'guest'
}

export function TopBar() {
  const [profileOpen, setProfileOpen] = useState(false)
  const [user, setUser] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (data.authenticated && data.user) {
          setUser(data.user)
        }
      })
      .catch(err => {
        console.error('Error fetching user profile:', err)
      })
      .finally(() => setLoading(false))
  }, [])

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'GET',
        credentials: 'include'
      })
      window.location.href = '/auth'
    } catch (err) {
      console.error('Logout error:', err)
      window.location.href = '/auth'
    }
  }

  const getRoleColor = (role: string) => {
    switch (role) {
      case 'admin': return 'bg-red-500/20 text-red-500 hover:bg-red-500/30'
      case 'user': return 'bg-green-500/20 text-green-500 hover:bg-green-500/30'
      case 'guest': return 'bg-amber-500/20 text-amber-500 hover:bg-amber-500/30'
      default: return 'bg-gray-500/20 text-gray-500'
    }
  }

  return (
    <div className="flex items-center gap-2">
      {/* User Profile */}
      <Popover open={profileOpen} onOpenChange={setProfileOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-2">
            <User className="w-4 h-4" />
            {!loading && user && (
              <span className="text-sm font-medium hidden md:inline">{user.email}</span>
            )}
            {loading && <span className="text-xs text-muted-foreground">Loading...</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56" align="end">
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Profile</p>
              {!loading && user && (
                <>
                  <p className="text-xs text-muted-foreground break-all">{user.email}</p>
                  <Badge className={getRoleColor(user.role)}>
                    {user.role}
                  </Badge>
                </>
              )}
            </div>
            <div className="pt-2 border-t">
              <Button 
                variant="ghost" 
                size="sm" 
                className="w-full justify-start text-red-500 hover:text-red-600 hover:bg-red-50"
                onClick={handleLogout}
              >
                <LogOut className="w-4 h-4 mr-2" />
                Logout
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
