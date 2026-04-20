'use client'
import { Link } from '@tanstack/react-router'
import {
  LayoutDashboard,
  Key,
  Settings,
  BookOpen,
  Shield,
  Terminal,
} from 'lucide-react'
import type { UseAuthReturn } from '@/hooks/useAuth'
import { useHealth } from '@/hooks/useHealth'

const base = 'w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-left'
const sharedLinkProps = {
  className: base,
  activeProps: { className: 'bg-primary text-primary-foreground' },
  inactiveProps: { className: 'hover:bg-accent text-muted-foreground' },
}

interface SidebarProps {
  auth: UseAuthReturn
}

export function Sidebar({ auth }: SidebarProps) {
  const { user } = auth
  const { data: health } = useHealth()
  const showConsole = user?.role === 'admin' && health?.features.console === true
  return (
    <nav className="space-y-2">
      <Link to="/" {...sharedLinkProps} activeOptions={{ exact: true }}>
        <LayoutDashboard className="w-5 h-5" />
        <span>Overview</span>
      </Link>
      <Link to="/keys" {...sharedLinkProps}>
        <Key className="w-5 h-5" />
        <span>API Keys</span>
      </Link>
      <Link to="/settings" {...sharedLinkProps}>
        <Settings className="w-5 h-5" />
        <span>Settings</span>
      </Link>
      <Link to="/docs" {...sharedLinkProps}>
        <BookOpen className="w-5 h-5" />
        <span>Documentation</span>
      </Link>
      {user?.role === 'admin' && (
        <Link to="/admin" {...sharedLinkProps}>
          <Shield className="w-5 h-5" />
          <span>Admin</span>
        </Link>
      )}
      {showConsole && (
        <Link to="/console" {...sharedLinkProps}>
          <Terminal className="w-5 h-5" />
          <span>Console</span>
        </Link>
      )}
    </nav>
  )
}
