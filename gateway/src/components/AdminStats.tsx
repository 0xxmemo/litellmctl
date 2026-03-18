'use client'
import { useQuery } from '@tanstack/react-query'
import { StatCard } from '@/components/StatCard'
import { ModelUsagePieChart } from '@/components/ModelUsagePieChart'
import { Activity, DollarSign, Key, Zap } from 'lucide-react'
import { PrettyAmount } from '@/components/PrettyAmount'

interface GlobalStats {
  totalRequests?: number
  totalTokens?: number
  totalSpend?: number
  activeKeys?: number
  modelUsage?: Array<{
    name: string
    value: number
    percentage: string | number
  }>
}

async function fetchGlobalStats(): Promise<GlobalStats> {
  const r = await fetch('/api/dashboard/global-stats', { credentials: 'include' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export function AdminStats() {
  const { data: stats, error } = useQuery({
    queryKey: ['dashboard', 'global-stats'],
    queryFn: fetchGlobalStats,
    staleTime: 60_000,
  })

  if (error) return (
    <div className="p-4 border rounded-lg text-muted-foreground text-center">
      Unable to load admin stats: {error instanceof Error ? error.message : 'Unknown error'}
    </div>
  )

  if (!stats) return <div className="flex items-center justify-center h-64">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Requests (All Users)"
          value={<PrettyAmount amountFormatted={stats.totalRequests ?? 0} size="2xl" />}
          icon={Activity}
        />
        <StatCard
          title="Total Tokens (All Users)"
          value={<PrettyAmount amountFormatted={stats.totalTokens ?? 0} size="2xl" />}
          icon={Zap}
        />
        <StatCard
          title="Total Spend (All Users)"
          value={<PrettyAmount amountFormatted={stats.totalSpend ?? 0} size="2xl" usd={String(stats.totalSpend ?? 0)} usdInline />}
          icon={DollarSign}
        />
        <StatCard
          title="Active Keys (All Users)"
          value={<PrettyAmount amountFormatted={stats.activeKeys ?? 0} size="2xl" normalPrecision={0} />}
          icon={Key}
        />
      </div>

      {stats.modelUsage && stats.modelUsage.length > 0 && (
        <ModelUsagePieChart data={stats.modelUsage} />
      )}
    </div>
  )
}
