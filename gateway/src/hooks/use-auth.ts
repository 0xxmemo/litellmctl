import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

export interface User {
  email: string
  role: 'admin' | 'user' | 'guest'
  name?: string
  company?: string
}

interface AuthData {
  authenticated: boolean
  user?: User
}

// ── Fetch helpers (internal) ─────────────────────────────────────────────────

async function fetchAuthMe(): Promise<User | null> {
  const res = await fetch('/api/auth/me', { credentials: 'include' })
  if (!res.ok) return null
  const data: AuthData = await res.json()
  if (data.authenticated && data.user) {
    return {
      email: data.user.email,
      role: data.user.role as 'admin' | 'user' | 'guest',
      name: data.user.name,
      company: data.user.company,
    }
  }
  return null
}

async function performLogout(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
  })
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useAuth() {
  const queryClient = useQueryClient()

  const { data: user, isLoading: loading } = useQuery({
    queryKey: queryKeys.auth,
    queryFn: fetchAuthMe,
    staleTime: 60_000,
    retry: false,
  })

  const refreshUser = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.auth })
  }

  return { user, loading, refreshUser }
}

export function useLogout() {
  return useMutation({
    mutationFn: performLogout,
    onSuccess: () => {
      window.location.href = '/'
    },
    onError: () => {
      window.location.href = '/'
    },
  })
}

export type UseAuthReturn = ReturnType<typeof useAuth>
export type UseLogoutReturn = ReturnType<typeof useLogout>
