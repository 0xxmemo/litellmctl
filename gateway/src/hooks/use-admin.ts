import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

// ── Types ────────────────────────────────────────────────────────────────────

export interface UserRecord {
  email: string
  role: 'admin' | 'user' | 'guest'
  createdAt: string
  approvedAt?: string
  /** Total API requests recorded in usage_logs for this user (admin list only). */
  requests?: number
  /** Total tokens from usage_logs for this user (admin list only). */
  tokens?: number
  /** Per-hour request counts for the last 24 hours, oldest → newest. */
  requests24h?: number[]
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

export function useSetUserRole() {
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

async function restartGatewayApi(): Promise<void> {
  const res = await fetch('/api/admin/restart', {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
}

export function useRestartGateway() {
  return useMutation({ mutationFn: restartGatewayApi })
}

async function killConsoleSessionApi(): Promise<{ killed: boolean }> {
  const res = await fetch('/api/admin/console', {
    method: 'DELETE',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export function useKillConsoleSession() {
  return useMutation({ mutationFn: killConsoleSessionApi })
}

export type UseAdminUsersReturn = ReturnType<typeof useAdminUsers>
export type UseApproveUserReturn = ReturnType<typeof useApproveUser>
export type UseRejectUserReturn = ReturnType<typeof useRejectUser>
export type UseAddUserReturn = ReturnType<typeof useAddUser>
export type UseDeleteUserReturn = ReturnType<typeof useDeleteUser>
export type UseSetUserRoleReturn = ReturnType<typeof useSetUserRole>
export type UseDisapproveAllReturn = ReturnType<typeof useDisapproveAll>
export type UseRevokeAllKeysReturn = ReturnType<typeof useRevokeAllKeys>
export type UseRestartGatewayReturn = ReturnType<typeof useRestartGateway>

// ── Teams ────────────────────────────────────────────────────────────────────

export interface TeamRecord {
  id: string
  name: string
  createdAt: number
  createdBy: string
  memberCount: number
}

async function fetchTeams(): Promise<TeamRecord[]> {
  const res = await fetch('/api/admin/teams', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (res.status === 403) throw new Error('Access denied — admin role required')
  if (!res.ok) throw new Error(`Server error: HTTP ${res.status}`)
  const data = await res.json()
  return data.teams || []
}

async function fetchTeamMembers(teamId: string): Promise<string[]> {
  const res = await fetch(`/api/admin/teams/${encodeURIComponent(teamId)}/members`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Server error: HTTP ${res.status}`)
  const data = await res.json()
  return data.members || []
}

export function useTeams(enabled = true) {
  return useQuery({
    queryKey: queryKeys.adminTeams,
    queryFn: fetchTeams,
    enabled,
  })
}

export function useTeamMembers(teamId: string | null) {
  return useQuery({
    queryKey: queryKeys.adminTeamMembers(teamId ?? ''),
    queryFn: () => fetchTeamMembers(teamId as string),
    enabled: !!teamId,
  })
}

export function useCreateTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch('/api/admin/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data.team as TeamRecord
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.adminTeams }),
  })
}

export function useDeleteTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/teams/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return id
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.adminTeams }),
  })
}

export function useAddTeamMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ teamId, email }: { teamId: string; email: string }) => {
      const res = await fetch(`/api/admin/teams/${encodeURIComponent(teamId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return { teamId, email }
    },
    onSuccess: ({ teamId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.adminTeamMembers(teamId) })
      qc.invalidateQueries({ queryKey: queryKeys.adminTeams })
    },
  })
}

export function useRemoveTeamMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ teamId, email }: { teamId: string; email: string }) => {
      const res = await fetch(
        `/api/admin/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(email)}`,
        { method: 'DELETE', credentials: 'include' },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return { teamId, email }
    },
    onSuccess: ({ teamId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.adminTeamMembers(teamId) })
      qc.invalidateQueries({ queryKey: queryKeys.adminTeams })
    },
  })
}

export type UseTeamsReturn = ReturnType<typeof useTeams>
export type UseTeamMembersReturn = ReturnType<typeof useTeamMembers>
export type UseCreateTeamReturn = ReturnType<typeof useCreateTeam>
export type UseDeleteTeamReturn = ReturnType<typeof useDeleteTeam>
export type UseAddTeamMemberReturn = ReturnType<typeof useAddTeamMember>
export type UseRemoveTeamMemberReturn = ReturnType<typeof useRemoveTeamMember>
