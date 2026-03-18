import {} from 'react'
import { AdminSection } from '@/components/AdminSection'
import { APIKeyManager } from '@/components/APIKeyManager'
import { useAuth } from '@/hooks/useAuth'

export function DashboardHome() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[400px]">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Admin Section - Only admins see (includes global metrics) */}
      {user?.role === 'admin' && <AdminSection user={user} />}

      {/* API Keys - Everyone sees */}
      <APIKeyManager />
    </div>
  )
}
