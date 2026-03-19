'use client'
/**
 * src/context/AppContext.tsx
 *
 * Centralized data provider for the LLM Gateway dashboard.
 *
 * - Fetches models, config, and stats; shares across all components
 * - Stats (globalStats, userStats) use React Query for caching, background refetch, deduplication
 * - Models fetched once on mount; config fetched on demand
 * - Provides manual refresh (e.g. after config saves)
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchModels,
  registerAliases,
  type NormalizedModel,
} from '@/lib/models'

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
const GLOBAL_STATS_KEY = ['dashboard', 'global-stats'] as const
const USER_STATS_KEY = ['dashboard', 'user-stats'] as const

// ─── Fetch helpers ────────────────────────────────────────────────────────────
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

const RATE_LIMIT_BACKOFF_MS = 5 * 60_000  // 5 min

export const AppContext = createContext<AppContextValue | null>(null)

// ─── Provider ────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()

  // ── Models ──────────────────────────────────────────────────────────────────
  const [models, setModels] = useState<NormalizedModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState<string | null>(null)

  // ── Config ──────────────────────────────────────────────────────────────────
  const [config, setConfig] = useState<LiteLLMConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)

  // ── Auth ────────────────────────────────────────────────────────────────────
  const [currentUser, setCurrentUser] = useState<{ email: string; role: 'admin' | 'user' | 'guest' } | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  // ── Rate limiting ────────────────────────────────────────────────────────────
  const [rateLimited, setRateLimited] = useState(false)

  const handleRateLimit = useCallback(() => {
    setRateLimited(true)
    setTimeout(() => setRateLimited(false), RATE_LIMIT_BACKOFF_MS)
  }, [])

  // ── Auth check (once on mount) ───────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated && data.user) {
          setCurrentUser(data.user)
        }
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true))
  }, [])

  // ── Models: fetch on mount ───────────────────────────────────────────────────
  const refreshModels = useCallback(async () => {
    setModelsLoading(true)
    setModelsError(null)
    try {
      const m = await fetchModels()
      setModels(m)
    } catch (e: unknown) {
      setModelsError(e instanceof Error ? e.message : 'Failed to load models')
    } finally {
      setModelsLoading(false)
    }
  }, [])

  useEffect(() => {
    setModelsLoading(true)
    fetchModels()
      .then((m) => {
        setModels(m)
        setModelsLoading(false)
      })
      .catch((e: Error) => {
        setModelsError(e.message)
        setModelsLoading(false)
      })
  }, [])

  // ── Config ──────────────────────────────────────────────────────────────────
  const refreshConfig = useCallback(async () => {
    setConfigLoading(true)
    setConfigError(null)
    try {
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
      setConfig(data)
      // Register model_group_alias keys for dynamic stub detection
      const aliases = Object.keys(
        (data.router_settings as any)?.model_group_alias ??
        data.model_group_alias ??
        {}
      )
      if (aliases.length > 0) registerAliases(aliases)
    } catch (e: unknown) {
      setConfigError(e instanceof Error ? e.message : 'Failed to load config')
    } finally {
      setConfigLoading(false)
    }
  }, [])

  // ── Global Stats — auto-enable once auth is confirmed (any authenticated user)
  // Matches reference: requiresApiKeyOrSession (guests can see global stats)
  const globalStatsEnabled = authChecked && !rateLimited

  const globalStatsQuery = useQuery({
    queryKey: GLOBAL_STATS_KEY,
    queryFn: async () => {
      try {
        return await fetchGlobalStats()
      } catch (err: any) {
        if (err?.status === 429) handleRateLimit()
        throw err
      }
    },
    enabled: globalStatsEnabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
    refetchIntervalInBackground: false,
  })

  // ── User Stats — auto-enable once auth confirmed and user is non-guest
  // Matches reference: requireUserOrAdmin (guests blocked)
  const userStatsEnabled = authChecked && !!currentUser && currentUser.role !== 'guest'

  const userStatsQuery = useQuery({
    queryKey: USER_STATS_KEY,
    queryFn: async () => {
      try {
        return await fetchUserStatsFromApi()
      } catch (err: any) {
        if (err?.status === 429) handleRateLimit()
        throw err
      }
    },
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
      refreshModels(),
      refreshConfig(),
      queryClient.invalidateQueries({ queryKey: ['litellm', 'config'] }),
    ])
  }, [refreshModels, refreshConfig, queryClient])

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
