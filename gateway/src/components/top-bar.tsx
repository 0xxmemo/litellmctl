'use client'
import { useState } from 'react'
import { LogOut, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import type { UseAuthReturn } from '@/hooks/useAuth'

interface TopBarProps {
  auth: UseAuthReturn
  onLogout: () => void
}

function roleVariant(role: string): 'default' | 'success' | 'warning' | 'outline' {
  switch (role) {
    case 'admin': return 'default'
    case 'user': return 'success'
    case 'guest': return 'warning'
    default: return 'outline'
  }
}

export function TopBar({ auth, onLogout }: TopBarProps) {
  const { user, loading } = auth
  const [profileOpen, setProfileOpen] = useState(false)

  return (
    <div className="flex items-center gap-2">
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
                  <Badge variant={roleVariant(user.role)}>
                    {user.role}
                  </Badge>
                </>
              )}
            </div>
            <div className="pt-2 border-t border-border/50">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-ui-danger-fg hover:bg-ui-danger-soft-bg"
                onClick={onLogout}
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
