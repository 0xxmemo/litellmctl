'use client'
import { Link, useLocation } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Key,
  Settings,
  BookOpen,
  Shield
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

const navItems = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/keys', label: 'API Keys', icon: Key },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
  { href: '/dashboard/docs', label: 'Documentation', icon: BookOpen },
]

export function Sidebar() {
  const location = useLocation()
  const { user } = useAuth()
  
  return (
    <nav className="space-y-2">
      {navItems.map((item) => {
        const Icon = item.icon
        const isActive = location.pathname === item.href
        
        return (
          <Link
            key={item.href}
            to={item.href}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-md transition-colors',
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-accent text-muted-foreground'
            )}
          >
            <Icon className="w-5 h-5" />
            <span>{item.label}</span>
          </Link>
        )
      })}
      
      {user?.role === 'admin' && (
        <Link
          to="/dashboard/admin"
          className={cn(
            'flex items-center gap-3 px-3 py-2 rounded-md transition-colors',
            location.pathname === '/dashboard/admin'
              ? 'bg-primary text-primary-foreground'
              : 'hover:bg-accent text-muted-foreground'
          )}
        >
          <Shield className="w-5 h-5" />
          <span>Admin</span>
        </Link>
      )}
    </nav>
  )
}
