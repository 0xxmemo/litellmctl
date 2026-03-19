import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { registerAliases } from '@lib/models'

// ── Types ────────────────────────────────────────────────────────────────────

export interface LiteLLMConfig {
  model_group_alias?: Record<string, string>
  router_settings?: Record<string, unknown>
  litellm_settings?: Record<string, unknown>
  model_list?: Array<{
    model_name: string
    litellm_params: { model: string; api_base?: string; api_key?: string; [key: string]: unknown }
    model_info?: Record<string, unknown>
  }>
  fallbacks?: Array<Record<string, string[]>>
  [key: string]: unknown
}

// ── Fetch helpers (internal) ─────────────────────────────────────────────────

async function fetchModelOverrides(): Promise<Record<string, string>> {
  const r = await fetch('/api/user/model-overrides', { credentials: 'include' })
  const data = await r.json()
  return data.model_overrides || {}
}

async function fetchTierAliases(): Promise<Record<string, string>> {
  const r = await fetch('/api/config/aliases', { credentials: 'include' })
  const data = await r.json()
  return data.model_group_alias || {}
}

async function fetchConfig(): Promise<LiteLLMConfig> {
  const res = await fetch('/api/admin/litellm-config', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  const data = await res.json()
  if (!data.router_settings) data.router_settings = {}
  // Register model_group_alias keys for dynamic stub detection
  const aliases = Object.keys(
    (data.router_settings as any)?.model_group_alias ??
    data.model_group_alias ??
    {}
  )
  if (aliases.length > 0) registerAliases(aliases)
  return data
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

/**
 * Fetches the admin LiteLLM config and registers aliases for stub detection.
 * Only enabled for admin users.
 */
export function useConfig(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: fetchConfig,
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  })
}
