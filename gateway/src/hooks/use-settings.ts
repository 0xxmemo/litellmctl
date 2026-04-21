import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

// ── Fetch helpers (internal) ─────────────────────────────────────────────────

async function fetchModelOverrides(): Promise<Record<string, string>> {
  const r = await fetch('/api/user/model-overrides', { credentials: 'include' })
  const data = await r.json()
  return data.model_overrides || {}
}

async function fetchTierAliases(): Promise<Record<string, string>> {
  const r = await fetch('/api/user/aliases', { credentials: 'include' })
  const data = await r.json()
  return data.model_group_alias || {}
}

async function saveModelOverridesApi(overrides: Record<string, string>): Promise<Record<string, string>> {
  const payload: Record<string, string> = {}
  for (const [k, v] of Object.entries(overrides)) {
    if (v && v.trim()) payload[k] = v
  }
  const res = await fetch('/api/user/model-overrides', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Failed to save overrides')
  return data.model_overrides || {}
}

async function saveProfileApi(profile: { name: string; email: string; company: string }): Promise<void> {
  const res = await fetch('/api/user/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(profile),
  })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error || 'Failed to update profile')
  }
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useModelOverrides() {
  return useQuery({
    queryKey: queryKeys.modelOverrides,
    queryFn: fetchModelOverrides,
  })
}

export function useSaveModelOverrides() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: saveModelOverridesApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.modelOverrides })
    },
  })
}

export function useTierAliases() {
  return useQuery({
    queryKey: queryKeys.configAliases,
    queryFn: fetchTierAliases,
  })
}

export function useSaveProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: saveProfileApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth })
    },
  })
}

export type UseModelOverridesReturn = ReturnType<typeof useModelOverrides>
export type UseSaveModelOverridesReturn = ReturnType<typeof useSaveModelOverrides>
export type UseTierAliasesReturn = ReturnType<typeof useTierAliases>
export type UseSaveProfileReturn = ReturnType<typeof useSaveProfile>
