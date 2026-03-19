'use client'
/**
 * src/context/AppContext.tsx
 *
 * Centralized data provider for the LLM Gateway dashboard.
 *
 * - Fetches models, config, and stats; shares across all components
 * - Stats (globalStats, userStats) use React Query for caching, background refetch, deduplication
 * - Models and config use React Query
 * - Auth uses React Query
 * - Provides manual refresh (e.g. after config saves)
 */

import React, {
  createContext,
  useCallback,
  useContext,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  registerAliases,
  type NormalizedModel,
} from '@lib/models'
import { fetchModels } from '@/lib/models-hooks'
import { queryKeys } from '@/lib/query-keys'

// ─── Types ────────────────────────────────────────────────────────────────────

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

export interface UserStats {
  requests: number
  tokens: number
  spend: number
  keys: number
  dailyRequests?: Array<{ date: string; requests: number }>
  modelUsage?: Array<{
    model_name: string
    requests: number
    tokens: number
    spend: number
    percentage: string
  }>
}

export interface GlobalStats {
  totalRequests: number | null
  totalTokens: number | null
  totalUsers: number
  totalSpend: number
  activeKeys: number
  modelUsage: Array<{
    model_name: string
    provider?: string
    health?: string
    mode?: string
    requests: number | null
    tokens: number | null
    spend: number
    percentage: string | null
  }>
  topUsers: Array<{ email: string; role: string; requests: number; spend: number; keys: number }>
}

export interface AppContextValue {
  // ── Models ──────────────────────────────────────────────────────────────────
  models: NormalizedModel[]
  modelsLoading: boolean
  modelsError: string | null
  refreshModels: () => Promise<void>

  // ── Config ──────────────────────────────────────────────────────────────────
  config: LiteLLMConfig | null
  configLoading: boolean
  configError: string | null
  refreshConfig: () => Promise<void>

  // ── Global Stats ────────────────────────────────────────────────────────────
  globalStats: GlobalStats | null
  globalStatsLoading: boolean
  globalStatsError: string | null
  globalStatsUpdatedAt: number | null
  globalStatsSpinning: boolean
  refreshGlobalStats: () => Promise<void>

  // ── User Stats ──────────────────────────────────────────────────────────────
  userStats: UserStats | null
  userStatsLoading: boolean
  userStatsError: string | null
  userStatsUpdatedAt: number | null
  userStatsSpinning: boolean
  refreshUserStats: () => Promise<void>

  // ── Auth ────────────────────────────────────────────────────────────────────
  currentUser: { email: string; role: 'admin' | 'user' | 'guest' } | null
  authChecked: boolean

  // ── Convenience ─────────────────────────────────────────────────────────────
  /** Refresh models + config (call after saving config) */
  refreshAfterSave: () => Promise<void>
  /** Rate-limit state — true while in 5-minute backoff */
  rateLimited: boolean
}

// ─── Query key constants ──────────────────────────────────────────────────────
const GLOBAL_STATS_KEY = queryKeys.globalStats
const USER_STATS_KEY = queryKeys.userStats
const AUTH_ME_KEY = queryKeys.auth
const MODELS_KEY = queryKeys.models
const CONFIG_KEY = queryKeys.config

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchAuthMe(): Promise<{ email: string; role: 'admin' | 'user' | 'guest' } | null> {
  const r = await fetch('/api/auth/me', { credentials: 'include' })
  if (!r.ok) return null
  const data = await r.json()
  if (data.authenticated && data.user) {
    return data.user
  }
  return null
}

async function fetchGlobalStats(): Promise<GlobalStats> {
  const r = await fetch('/api/dashboard/global-stats', { credentials: 'include' })
  if (r.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data = await r.json()
  if (data.error) throw new Error(data.error)
  return data
}

async function fetchUserStatsFromApi(): Promise<UserStats> {
  const r = await fetch('/api/dashboard/user-stats', { credentials: 'include' })
  if (r.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data = await r.json()
  if (data.error) throw new Error(data.error)
  return {
    requests: data.requests ?? 0,
    tokens: data.tokens ?? 0,
    spend: data.spend ?? 0,
    keys: data.keys ?? 0,
    modelUsage: data.modelUsage,
    dailyRequests: data.dailyRequests,
  }
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

export const AppContext = createContext<AppContextValue | null>(null)

// ─── Provider ────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()

  // ── Auth ────────────────────────────────────────────────────────────────────
  const authQuery = useQuery({
    queryKey: AUTH_ME_KEY,
    queryFn: fetchAuthMe,
    staleTime: 60_000,
  })

  const currentUser = authQuery.data ?? null
  const authChecked = !authQuery.isLoading

  // ── Models ──────────────────────────────────────────────────────────────────
  const modelsQuery = useQuery({
    queryKey: MODELS_KEY,
    queryFn: fetchModels,
  })

  const models = modelsQuery.data ?? []
  const modelsLoading = modelsQuery.isLoading
  const modelsError = modelsQuery.error ? (modelsQuery.error instanceof Error ? modelsQuery.error.message : 'Failed to load models') : null

  const refreshModels = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: MODELS_KEY })
  }, [queryClient])

  // ── Config ──────────────────────────────────────────────────────────────────
  const configQuery = useQuery({
    queryKey: CONFIG_KEY,
    queryFn: fetchConfig,
    enabled: authChecked && currentUser?.role === 'admin',
    staleTime: 60_000,
  })

  const config = configQuery.data ?? null
  const configLoading = configQuery.isLoading
  const configError = configQuery.error ? (configQuery.error instanceof Error ? configQuery.error.message : 'Failed to load config') : null

  const refreshConfig = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: CONFIG_KEY })
  }, [queryClient])

  // ── Rate limiting (derived from query errors) ──────────────────────────────
  // We track rate limiting via query error state rather than manual useState
  const rateLimited = false // simplified: react-query retry handles backoff

  // ── Global Stats — auto-enable once auth is confirmed
  const globalStatsEnabled = authChecked && !rateLimited

  const globalStatsQuery = useQuery({
    queryKey: GLOBAL_STATS_KEY,
    queryFn: fetchGlobalStats,
    enabled: globalStatsEnabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
    refetchIntervalInBackground: false,
  })

  // ── User Stats — auto-enable once auth confirmed and user is non-guest
  const userStatsEnabled = authChecked && !!currentUser && currentUser.role !== 'guest'

  const userStatsQuery = useQuery({
    queryKey: USER_STATS_KEY,
    queryFn: fetchUserStatsFromApi,
    enabled: userStatsEnabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
    refetchIntervalInBackground: false,
  })

  // ── Manual refresh (invalidate without toggling enabled) ─────────────────────
  const refreshGlobalStats = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: GLOBAL_STATS_KEY })
  }, [queryClient])

  const refreshUserStats = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: USER_STATS_KEY })
  }, [queryClient])

  // ── refreshAfterSave ─────────────────────────────────────────────────────────
  const refreshAfterSave = useCallback(async () => {
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: MODELS_KEY }),
      queryClient.invalidateQueries({ queryKey: CONFIG_KEY }),
    ])
  }, [queryClient])

  // ── Build derived values from query state ─────────────────────────────────────
  const globalStats = globalStatsQuery.data ?? null
  const globalStatsLoading = globalStatsQuery.isLoading
  const globalStatsError = globalStatsQuery.error ? (globalStatsQuery.error instanceof Error ? globalStatsQuery.error.message : 'Error') : null
  const globalStatsUpdatedAt = globalStatsQuery.dataUpdatedAt || null
  const globalStatsSpinning = globalStatsQuery.isFetching && !globalStatsQuery.isLoading

  const userStats = userStatsQuery.data ?? null
  const userStatsLoading = userStatsQuery.isLoading
  const userStatsError = userStatsQuery.error ? (userStatsQuery.error instanceof Error ? userStatsQuery.error.message : 'Error') : null
  const userStatsUpdatedAt = userStatsQuery.dataUpdatedAt || null
  const userStatsSpinning = userStatsQuery.isFetching && !userStatsQuery.isLoading

  const value: AppContextValue = {
    models,
    modelsLoading,
    modelsError,
    refreshModels,

    config,
    configLoading,
    configError,
    refreshConfig,

    globalStats,
    globalStatsLoading,
    globalStatsError,
    globalStatsUpdatedAt,
    globalStatsSpinning,
    refreshGlobalStats,

    userStats,
    userStatsLoading,
    userStatsError,
    userStatsUpdatedAt,
    userStatsSpinning,
    refreshUserStats,

    currentUser,
    authChecked,

    refreshAfterSave,
    rateLimited,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) {
    throw new Error('useAppContext must be used within <AppProvider>')
  }
  return ctx
}
