'use client'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Key,
  Settings,
  BookOpen,
  Shield,
  BarChart3
} from 'lucide-react'

interface NavItem {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  requiresAdmin?: boolean
}

const navItems: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'keys', label: 'API Keys', icon: Key },
  { id: 'stats', label: 'Usage Stats', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'docs', label: 'Documentation', icon: BookOpen },
]

interface SidebarProps {
  currentPage?: string
  onPageChange?: (page: string) => void
  userRole?: string | null
}

export function Sidebar({ currentPage = 'keys', onPageChange, userRole }: SidebarProps) {
  const handleNav = (id: string) => {
    if (onPageChange) {
      onPageChange(id)
    } else {
      // Fallback: use hash navigation
      window.location.hash = `#${id}`
    }
  }

  return (
    <nav className="space-y-2">
      {navItems.map((item) => {
        if (item.requiresAdmin && userRole !== 'admin') return null

        const Icon = item.icon
        const isActive = currentPage === item.id

        return (
          <button
            key={item.id}
            onClick={() => handleNav(item.id)}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-left',
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-accent text-muted-foreground'
            )}
          >
            <Icon className="w-5 h-5" />
            <span>{item.label}</span>
          </button>
        )
      })}

      {userRole === 'admin' && (
        <button
          onClick={() => handleNav('admin')}
          className={cn(
            'w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-left',
            currentPage === 'admin'
              ? 'bg-primary text-primary-foreground'
              : 'hover:bg-accent text-muted-foreground'
          )}
        >
          <Shield className="w-5 h-5" />
          <span>Admin</span>
        </button>
      )}
    </nav>
  )
}
