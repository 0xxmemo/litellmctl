import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    // Check auth status via single /api/auth/me endpoint
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' })
      const data = await res.json()
      if (data.authenticated && data.user?.role !== 'guest') {
        throw redirect({ to: '/dashboard' })
      } else {
        throw redirect({ to: '/auth' })
      }
    } catch (e: any) {
      // Re-throw redirect
      if (e?.isRedirect || e?._type === 'redirect' || e?.href) {
        throw e
      }
      // On error, go to auth
      throw redirect({ to: '/auth' })
    }
  },
})
