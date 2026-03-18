import { createFileRoute, redirect } from '@tanstack/react-router'
import { Docs } from '@/pages/Docs'

export const Route = createFileRoute('/dashboard/docs')({
  beforeLoad: async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' })
      const data = await res.json()
      if (!data.authenticated || data.user?.role === 'guest') {
        throw redirect({ to: '/auth' })
      }
    } catch (e: any) {
      if (e?.isRedirect || e?._type === 'redirect' || e?.href) throw e
      throw redirect({ to: '/auth' })
    }
  },
  component: () => <Docs />,
})
