import { createFileRoute, redirect } from '@tanstack/react-router'
import { AuthPage } from '@/pages/AuthPage'

export const Route = createFileRoute('/auth')({
  beforeLoad: async () => {
    // Check if already authenticated - redirect to dashboard
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' })
      const data = await res.json()
      if (data.authenticated && data.user?.role !== 'guest') {
        throw redirect({ to: '/dashboard/keys' })
      }
    } catch (e) {
      // If redirect was thrown, re-throw it
      if ((e as any)?.message?.includes('redirect') || (e as any)?._type === 'redirect' || (e as any)?.href) {
        throw e
      }
      // Network error - stay on auth page
    }
  },
  component: AuthPage,
})
