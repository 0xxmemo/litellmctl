import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

// ── Types ────────────────────────────────────────────────────────────────────

export interface APIKey {
  _id?: string
  id?: string
  name?: string
  key?: string
  alias?: string
  created?: string
  createdAt?: string
  expires?: string
  requests?: number
  status?: 'active' | 'revoked' | 'expired'
  revoked?: boolean
  email?: string
}

export interface KeysResponse {
  keys: APIKey[]
  page: number
  limit: number
  total: number
  totalPages: number
}

// ── Fetch helpers (internal) ─────────────────────────────────────────────────

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    redirect: 'follow',
  })
  if (res.status === 401 || res.status === 403) {
    return null
  }
  return res
}

async function fetchKeys(page: number, limit: number): Promise<KeysResponse> {
  const res = await apiFetch(`/api/keys?page=${page}&limit=${limit}`)
  if (!res) return { keys: [], page: 1, limit, total: 0, totalPages: 0 }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function createKeyApi(name: string): Promise<{ key?: string; apiKey?: string; keyId?: string }> {
  const res = await fetch('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ name: name || 'New API Key' }),
  })
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(errData.error || `HTTP ${res.status}`)
  }
  return res.json()
}

async function updateKeyApi({ id, name, alias }: { id: string; name?: string; alias?: string }): Promise<void> {
  const res = await fetch(`/api/keys/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ name, alias }),
  })
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(errData.error || `HTTP ${res.status}`)
  }
}

async function revokeKeyApi(id: string): Promise<void> {
  const res = await fetch(`/api/keys/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(errData.error || `HTTP ${res.status}`)
  }
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useKeys(page = 1, limit = 20) {
  return useQuery({
    queryKey: queryKeys.keys(page),
    queryFn: () => fetchKeys(page, limit),
  })
}

export function useCreateKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => createKeyApi(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })
}

export function useUpdateKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (params: { id: string; name?: string; alias?: string }) => updateKeyApi(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })
}

export function useRevokeKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => revokeKeyApi(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })
}

export type UseKeysReturn = ReturnType<typeof useKeys>
export type UseCreateKeyReturn = ReturnType<typeof useCreateKey>
export type UseUpdateKeyReturn = ReturnType<typeof useUpdateKey>
export type UseRevokeKeyReturn = ReturnType<typeof useRevokeKey>
