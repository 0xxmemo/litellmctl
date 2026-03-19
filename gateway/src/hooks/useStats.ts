import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

// ── Types ────────────────────────────────────────────────────────────────────

export interface GlobalStats {
  totalRequests?: number
  totalTokens?: number
  totalSpend?: number
  totalUsers?: number
  activeKeys?: number
  modelUsage?: Array<{
    model_name: string
    requests: number
    tokens: number
    spend: number
    percentage: string | number
  }>
  topUsers?: Array<{ email: string; role: string; requests: number; spend: number; keys: number }>
}

// ── Fetch helpers (internal) ─────────────────────────────────────────────────

async function fetchGlobalStats(): Promise<GlobalStats> {
  const r = await fetch('/api/dashboard/global-stats', { credentials: 'include' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function fetchUserStats() {
  const res = await fetch('/api/dashboard/user-stats', {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useGlobalStats(options?: { staleTime?: number }) {
  return useQuery({
    queryKey: queryKeys.globalStats,
    queryFn: fetchGlobalStats,
    staleTime: options?.staleTime ?? 60_000,
  })
}

export function useUserStats(options?: { refetchInterval?: number | false; staleTime?: number }) {
  return useQuery({
    queryKey: queryKeys.userStats,
    queryFn: fetchUserStats,
    refetchInterval: options?.refetchInterval,
    staleTime: options?.staleTime ?? 30_000,
  })
}

export function useUserStatsAnalytics() {
  return useQuery({
    queryKey: queryKeys.userStatsAnalytics,
    queryFn: fetchUserStats,
  })
}
