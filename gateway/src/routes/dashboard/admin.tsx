import { createFileRoute, redirect } from '@tanstack/react-router'
import { Admin } from '@/pages/Admin'

export const Route = createFileRoute('/dashboard/admin')({
  beforeLoad: async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' })
      const data = await res.json()
      if (!data.authenticated) {
        throw redirect({ to: '/auth' })
      }
      if (data.user?.role !== 'admin') {
        throw redirect({ to: '/dashboard/keys' })
      }
    } catch (e: any) {
      if (e?.isRedirect || e?._type === 'redirect' || e?.href) throw e
      throw redirect({ to: '/auth' })
    }
  },
  component: () => <Admin />,
})
