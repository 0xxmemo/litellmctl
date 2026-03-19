import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

// ── Types ────────────────────────────────────────────────────────────────────

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

export interface UserStats {
  requests: number
  tokens: number
  spend: number
  keys: number
  requestsChange?: string
  tokensChange?: string
  spendChange?: string
  keysChange?: string
  dailyRequests?: Array<{ date: string; requests: number }>
  modelUsage?: Array<{
    model_name: string
    requests: number
    tokens: number
    spend: number
    percentage: string
  }>
}

// ── Fetch helpers (internal) ─────────────────────────────────────────────────

async function fetchGlobalStats(): Promise<GlobalStats> {
  const r = await fetch('/api/stats/global', { credentials: 'include' })
  if (r.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data = await r.json()
  if (data.error) throw new Error(data.error)
  return data
}

async function fetchUserStats(): Promise<UserStats> {
  const res = await fetch('/api/stats/user', {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  })
  if (res.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
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

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useGlobalStats(options?: { staleTime?: number; enabled?: boolean }) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.globalStats,
    queryFn: fetchGlobalStats,
    enabled: options?.enabled,
    staleTime: options?.staleTime ?? 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.globalStats })
  }

  return {
    ...query,
    globalStats: query.data ?? null,
    globalStatsLoading: query.isLoading,
    globalStatsError: query.error ? (query.error instanceof Error ? query.error.message : 'Error') : null,
    globalStatsUpdatedAt: query.dataUpdatedAt || null,
    globalStatsSpinning: query.isFetching && !query.isLoading,
    refreshGlobalStats: refresh,
  }
}

export function useUserStats(options?: { refetchInterval?: number | false; staleTime?: number; enabled?: boolean }) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.userStats,
    queryFn: fetchUserStats,
    enabled: options?.enabled,
    refetchInterval: options?.refetchInterval ?? 60_000,
    staleTime: options?.staleTime ?? 30_000,
    refetchIntervalInBackground: false,
  })

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.userStats })
  }

  return {
    ...query,
    userStats: query.data ?? null,
    userStatsLoading: query.isLoading,
    userStatsError: query.error ? (query.error instanceof Error ? query.error.message : 'Error') : null,
    userStatsUpdatedAt: query.dataUpdatedAt || null,
    userStatsSpinning: query.isFetching && !query.isLoading,
    refreshUserStats: refresh,
  }
}

export function useUserStatsAnalytics() {
  return useQuery({
    queryKey: queryKeys.userStatsAnalytics,
    queryFn: fetchUserStats,
  })
}

export type UseGlobalStatsReturn = ReturnType<typeof useGlobalStats>
export type UseUserStatsReturn = ReturnType<typeof useUserStats>
export type UseUserStatsAnalyticsReturn = ReturnType<typeof useUserStatsAnalytics>
