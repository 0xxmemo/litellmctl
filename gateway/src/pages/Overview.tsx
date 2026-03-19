'use client'
import { useEffect, useRef, useState } from 'react'
import { StatCard } from '@/components/StatCard'
import { Activity, Key, DollarSign, Zap, Users, Globe, TrendingUp, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { PrettyAmount } from '@/components/PrettyAmount'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ModelUsagePieChart } from '@/components/ModelUsagePieChart'
import { RequestsTable } from '@/components/RequestsTable'
import { getDisplayName, formatProviderName, getProviderColor, extractProvider, resolveProvider } from '@lib/models'
import { useAppContext } from '@/context/AppContext'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

// Build chart data from real daily breakdown returned by the API.
// Falls back to a 30-day zero-filled array if no data is available yet.
function buildUserChart(stats: { requests: number; dailyRequests?: Array<{ date: string; requests: number }> } | null) {
  if (stats?.dailyRequests && stats.dailyRequests.length > 0) {
    return stats.dailyRequests
  }
  // Fallback: 30 days of zeros
  const days = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    days.push({ date: label, requests: 0 })
  }
  return days
}

function UsageChart({ data, loading }: { data: Array<{ date: string; requests: number }>; loading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Your Requests Over Time</CardTitle>
        <CardDescription>Daily API request volume</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="date" className="text-xs" tick={{ fontSize: 11 }} />
              <YAxis className="text-xs" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                }}
              />
              <Line
                type="monotone"
                dataKey="requests"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={{ r: 3 }}
                name="Requests"
              />
            </LineChart>
          </ResponsiveContainer>
          {loading && (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              Loading chart...
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** Shows "Updated Xs ago" with a spinning indicator during active refreshes */
function LastUpdated({ ts, spinning }: { ts: number | null; spinning: boolean }) {
  const [label, setLabel] = useState<string>('—')

  useEffect(() => {
    if (!ts) return
    const tick = () => {
      const secs = Math.floor((Date.now() - ts) / 1000)
      setLabel(secs < 5 ? 'just now' : `${secs}s ago`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [ts])

  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground select-none">
      <RefreshCw className={`w-3 h-3 ${spinning ? 'animate-spin' : ''}`} />
      Updated {label}
    </span>
  )
}

export function Overview() {
  const {
    currentUser,
    authChecked,
    globalStats,
    globalStatsLoading,
    globalStatsUpdatedAt,
    globalStatsSpinning,
    refreshGlobalStats,
    userStats,
    userStatsLoading,
    userStatsUpdatedAt,
    userStatsSpinning,
    refreshUserStats,
    rateLimited,
  } = useAppContext()

  const [activeTab, setActiveTab] = useState<string>('global')
  const isLoggedIn = !!currentUser

  // Tracks which tabs have had their initial fetch triggered
  const globalFetchedRef = useRef(false)
  const userFetchedRef = useRef(false)

  // Lazy fetch: only load a tab's data when that tab is first visited
  useEffect(() => {
    if (!authChecked) return

    if (activeTab === 'global' && !globalFetchedRef.current) {
      globalFetchedRef.current = true
      refreshGlobalStats()
    } else if (activeTab === 'my-usage' && !userFetchedRef.current) {
      userFetchedRef.current = true
      refreshUserStats()
    }
  }, [activeTab, authChecked]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-switch to "my-usage" tab when user logs in
  useEffect(() => {
    if (isLoggedIn && authChecked) {
      setActiveTab('my-usage')
    }
  }, [isLoggedIn, authChecked])

  const userChartData = buildUserChart(userStats)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Overview</h1>
      </div>

      {/* Rate-limit banner */}
      {rateLimited && (
        <div className="flex items-center gap-2 rounded-md border border-yellow-400/40 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-700 dark:text-yellow-300">
          <RefreshCw className="w-4 h-4 shrink-0" />
          <span>Too many requests — stats will refresh automatically in ~5 minutes.</span>
        </div>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          {isLoggedIn && (
            <TabsTrigger value="my-usage" className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5" />
              My Usage
            </TabsTrigger>
          )}
          <TabsTrigger value="global" className="flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5" />
            Global
          </TabsTrigger>
        </TabsList>

        {/* ── Global Tab ── */}
        <TabsContent value="global" className="space-y-6 mt-4">
          {/* Last updated indicator */}
          <div className="flex justify-end">
            <LastUpdated ts={globalStatsUpdatedAt} spinning={globalStatsSpinning} />
          </div>

          {/* Global stat cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              title="Total Users"
              value={<PrettyAmount amountFormatted={globalStatsLoading ? '...' : (globalStats?.totalUsers ?? 0)} size="2xl" normalPrecision={0} />}
              icon={Users}
            />
            <StatCard
              title="Total Requests"
              value={<PrettyAmount amountFormatted={globalStatsLoading ? '...' : (globalStats?.totalRequests ?? 0)} size="2xl" />}
              icon={Activity}
            />
            <StatCard
              title="Total Tokens"
              value={<PrettyAmount amountFormatted={globalStatsLoading ? '...' : (globalStats?.totalTokens ?? 0)} size="2xl" />}
              icon={Zap}
            />
            <StatCard
              title="Total Spend"
              value={<PrettyAmount amountFormatted={globalStatsLoading ? '...' : (globalStats?.totalSpend ?? 0)} size="2xl" usd={String(globalStats?.totalSpend ?? 0)} usdInline />}
              icon={DollarSign}
            />
          </div>

          {/* Model Usage */}
          {!globalStatsLoading && globalStats?.modelUsage && globalStats.modelUsage.length > 0 ? (
            <ModelUsagePieChart
              data={globalStats.modelUsage.map(m => {
                const provider = extractProvider(m.model_name) || resolveProvider(m.model_name, m.provider || '')
                return {
                  name: getDisplayName(m.model_name),
                  value: m.requests ?? m.spend ?? 0,
                  percentage: m.percentage || '0',
                  provider,
                  colorClass: getProviderColor(provider),
                  providerName: formatProviderName(provider),
                }
              })}
            />
          ) : !globalStatsLoading ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Model Usage Distribution</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-center text-muted-foreground py-8">
                  <Activity className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">No model usage data yet</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">Loading model data...</CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── My Usage Tab ── */}
        {isLoggedIn && (
          <TabsContent value="my-usage" className="space-y-6 mt-4">
            {/* Last updated indicator */}
            <div className="flex justify-end">
              <LastUpdated ts={userStatsUpdatedAt} spinning={userStatsSpinning} />
            </div>

            {/* Personal stat cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                title="Your Keys"
                value={<PrettyAmount amountFormatted={userStatsLoading ? '...' : (userStats?.keys ?? 0)} size="2xl" normalPrecision={0} />}
                icon={Key}
              />
              <StatCard
                title="Your Requests"
                value={<PrettyAmount amountFormatted={userStatsLoading ? '...' : (userStats?.requests ?? 0)} size="2xl" />}
                icon={Activity}
              />
              <StatCard
                title="Your Tokens"
                value={<PrettyAmount amountFormatted={userStatsLoading ? '...' : (userStats?.tokens ?? 0)} size="2xl" />}
                icon={Zap}
              />
              <StatCard
                title="Your Spend"
                value={<PrettyAmount amountFormatted={userStatsLoading ? '...' : (userStats?.spend ?? 0)} size="2xl" usd={String(userStats?.spend ?? 0)} usdInline />}
                icon={DollarSign}
              />
            </div>

            {/* Usage Chart */}
            <UsageChart data={userChartData} loading={userStatsLoading} />

            {/* My Model Breakdown */}
            {!userStatsLoading && userStats?.modelUsage && userStats.modelUsage.length > 0 ? (
              <ModelUsagePieChart
                data={userStats.modelUsage.map(m => {
                  const provider = extractProvider(m.model_name) || resolveProvider(m.model_name, '')
                  return {
                    name: getDisplayName(m.model_name),
                    value: m.requests ?? 0,
                    percentage: m.percentage || '0',
                    provider,
                    colorClass: getProviderColor(provider),
                    providerName: formatProviderName(provider),
                  }
                })}
              />
            ) : !userStatsLoading ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Your Model Usage</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-center text-muted-foreground py-8">
                    <Activity className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p className="text-sm">No model usage data yet</p>
                    <p className="text-xs mt-1">Model statistics appear here after your first API request</p>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {/* Recent Requests Table */}
            <RequestsTable />
          </TabsContent>
        )}
      </Tabs>

      {/* CTA for public users */}
      {!isLoggedIn && authChecked && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-8 gap-3">
            <TrendingUp className="w-10 h-10 text-muted-foreground opacity-40" />
            <p className="text-sm text-muted-foreground text-center">
              <a href="/auth" className="text-primary font-medium hover:underline">Sign in</a> to see your personal usage stats and usage chart.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
