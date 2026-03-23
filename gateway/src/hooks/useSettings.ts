import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { registerAliases } from '@lib/models'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelGroupAlias {
  [alias: string]: string
}

export interface FallbackChain {
  [primaryModel: string]: string[]
}

export interface RouterSettings {
  num_retries: number
  timeout: number | null
  cooldown_time: number
  allowed_fails: number
  retry_after: number
  enable_pre_call_checks: boolean
  set_verbose: boolean
  model_group_alias?: ModelGroupAlias
  fallbacks?: FallbackChain[]
  [key: string]: unknown
}

export interface ModelEntry {
  model_name: string
  litellm_params: { model: string; api_base?: string; api_key?: string; [key: string]: unknown }
  model_info?: Record<string, unknown>
}

export interface LiteLLMConfig {
  model_group_alias?: ModelGroupAlias
  router_settings?: RouterSettings
  litellm_settings?: Record<string, unknown>
  model_list?: ModelEntry[]
  fallbacks?: FallbackChain[]
  [key: string]: unknown
}

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

// ── ConfigEditor fetch helpers ────────────────────────────────────────────────

async function fetchEditorConfig(): Promise<LiteLLMConfig> {
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
  return data
}

async function patchEditorConfig(
  patch: { config: LiteLLMConfig; update_router?: boolean; save_to_file?: boolean },
): Promise<LiteLLMConfig> {
  console.log('[ConfigEditor] PUT /api/admin/litellm-config body:', JSON.stringify(patch, null, 2))
  const res = await fetch('/api/admin/litellm-config', {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    console.error('[ConfigEditor] PUT error response:', body)
    let errorMsg = body.error || body.detail
    if (Array.isArray(errorMsg)) {
      errorMsg = errorMsg.map((e: any) => e.msg || JSON.stringify(e)).join('; ')
    } else if (typeof errorMsg === 'object' && errorMsg !== null) {
      errorMsg = JSON.stringify(errorMsg)
    }
    throw new Error(errorMsg || `HTTP ${res.status}`)
  }
  return res.json()
}

async function resetEditorConfig(): Promise<unknown> {
  const res = await fetch('/api/admin/litellm-config/reset', {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || body.detail || `HTTP ${res.status}`)
  }
  return res.json().catch(() => ({}))
}

// ── useConfigEditor hook ──────────────────────────────────────────────────────

export function useConfigEditor() {
  const queryClient = useQueryClient()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['litellm', 'config'],
    queryFn: fetchEditorConfig,
    staleTime: 5 * 60_000,
  })

  const saveMutation = useMutation({
    mutationFn: patchEditorConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['litellm', 'config'] })
      queryClient.invalidateQueries({ queryKey: queryKeys.models })
      queryClient.invalidateQueries({ queryKey: queryKeys.config })
    },
  })

  const resetMutation = useMutation({
    mutationFn: resetEditorConfig,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['litellm', 'config'] })
      queryClient.invalidateQueries({ queryKey: queryKeys.models })
      queryClient.invalidateQueries({ queryKey: queryKeys.config })
    },
  })

  return { data, isLoading, error, refetch, saveMutation, resetMutation }
}

export type UseModelOverridesReturn = ReturnType<typeof useModelOverrides>
export type UseSaveModelOverridesReturn = ReturnType<typeof useSaveModelOverrides>
export type UseTierAliasesReturn = ReturnType<typeof useTierAliases>
export type UseSaveProfileReturn = ReturnType<typeof useSaveProfile>
export type UseConfigReturn = ReturnType<typeof useConfig>
export type UseConfigEditorReturn = ReturnType<typeof useConfigEditor>
