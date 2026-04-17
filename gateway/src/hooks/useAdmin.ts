import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

// ── Types ────────────────────────────────────────────────────────────────────

export interface UserRecord {
  email: string
  role: 'admin' | 'user' | 'guest'
  createdAt: string
  approvedAt?: string
}

// ── Fetch helpers (internal) ─────────────────────────────────────────────────

async function fetchAdminUsers(): Promise<UserRecord[]> {
  const res = await fetch('/api/admin/users', {
    credentials: 'include',
    redirect: 'manual',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  })
  if (res.status === 302 || res.status === 301 || res.type === 'opaqueredirect') {
    return []
  }
  if (res.status === 403) {
    throw new Error('Access denied — admin role required')
  }
  if (!res.ok) {
    throw new Error(`Server error: HTTP ${res.status}`)
  }
  const data = await res.json()
  return data.users || []
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useAdminUsers(enabled = true) {
  return useQuery({
    queryKey: queryKeys.adminUsers,
    queryFn: fetchAdminUsers,
    enabled,
  })
}

export function useApproveUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch('/api/admin/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      return email
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers })
    },
  })
}

export function useRejectUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch('/api/admin/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      return email
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers })
    },
  })
}

export function useAddUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ email, role }: { email: string; role: 'user' | 'admin' }) => {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, role }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      return email
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers })
    },
  })
}

export function useDeleteUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      return email
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers })
    },
  })
}

export function useDisapproveAll() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/admin/disapprove-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Failed to disapprove users')
      return response.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers })
    },
  })
}

export function useRevokeAllKeys() {
  return useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/admin/keys/revoke-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Failed to revoke all keys')
      return response.json()
    },
  })
}

export type UseAdminUsersReturn = ReturnType<typeof useAdminUsers>
export type UseApproveUserReturn = ReturnType<typeof useApproveUser>
export type UseRejectUserReturn = ReturnType<typeof useRejectUser>
export type UseAddUserReturn = ReturnType<typeof useAddUser>
export type UseDeleteUserReturn = ReturnType<typeof useDeleteUser>
export type UseDisapproveAllReturn = ReturnType<typeof useDisapproveAll>
export type UseRevokeAllKeysReturn = ReturnType<typeof useRevokeAllKeys>
