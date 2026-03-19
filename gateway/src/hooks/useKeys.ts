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

async function fetchKeys(): Promise<APIKey[]> {
  const res = await apiFetch('/api/keys')
  if (!res) return []
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.keys || []
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

export function useKeys() {
  return useQuery({
    queryKey: queryKeys.keys,
    queryFn: fetchKeys,
  })
}

export function useCreateKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => createKeyApi(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.keys })
    },
  })
}

export function useRevokeKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => revokeKeyApi(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.keys })
    },
  })
}
