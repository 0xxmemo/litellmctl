'use client'
import { useEffect, useState } from 'react'
import { StatCard } from '@/components/stat-card'
import { Activity, Key, Zap, TrendingUp, RefreshCw, Puzzle, BarChart3, Users, Globe } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PrettyAmount } from '@/components/pretty-amount'
import { ModelUsagePieChart } from '@/components/model-usage-pie-chart'
import { RequestsTable } from '@/components/requests-table'
import { PluginsOverview } from '@/components/plugins/plugins-overview'
import { getDisplayName, formatProviderName, extractProvider, resolveProvider } from '@lib/models'
import { useUserStats, useGlobalStats } from '@/hooks/use-stats'
import { useAuth } from '@/hooks/use-auth'
import { useRequestsTable } from '@/hooks/use-requests'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

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

const usageLineConfig = {
  requests: {
    label: 'Requests',
    color: 'var(--chart-1)',
  },
} satisfies ChartConfig

function UsageChart({
  data,
  loading,
  title = 'Your Requests Over Time',
  description = 'Daily API request volume',
}: {
  data: Array<{ date: string; requests: number }>
  loading: boolean
  title?: string
  description?: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex h-[260px] items-center justify-center text-muted-foreground text-sm">
            Loading chart...
          </div>
        ) : (
          <ChartContainer config={usageLineConfig} className="h-[260px] w-full min-h-[260px]">
            <LineChart accessibilityLayer data={data} margin={{ left: 8, right: 8, top: 8, bottom: 4 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tick={{ fontSize: 11 }}
              />
              <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={44} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
              <Line
                type="monotone"
                dataKey="requests"
                stroke="var(--color-requests)"
                strokeWidth={2}
                dot={{ r: 3, fill: 'var(--color-requests)' }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ChartContainer>
        )}
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
  const { user: currentUser, loading: authLoading } = useAuth()
  const authChecked = !authLoading
  const isLoggedIn = !!currentUser
  const isGuest = currentUser?.role === 'guest'
  const canSeeUsage = isLoggedIn && !isGuest
  const requestsTable = useRequestsTable()

  const {
    userStats,
    userStatsLoading,
    userStatsUpdatedAt,
    userStatsSpinning,
  } = useUserStats({ enabled: authChecked && canSeeUsage })

  const [activeTab, setActiveTab] = useState<string>('usage')

  const globalStatsQuery = useGlobalStats(authChecked && canSeeUsage && activeTab === 'global')
  const globalStats = globalStatsQuery.data ?? null
  const globalStatsLoading = globalStatsQuery.isLoading

  const rateLimited = false // react-query retry handles backoff

  const userChartData = buildUserChart(userStats)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Overview</h1>
      </div>

      {rateLimited && (
        <div className="glass glass--warning flex items-center gap-2 px-4 py-3 text-sm">
          <RefreshCw className="w-4 h-4 shrink-0" />
          <span>Too many requests — stats will refresh automatically in ~5 minutes.</span>
        </div>
      )}

      {/* Guest: pending access */}
      {authChecked && isLoggedIn && isGuest && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Access pending</CardTitle>
            <CardDescription>
              An administrator needs to approve your account before you can view usage and create API keys.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Signed-in user / admin: personal usage + plugins */}
      {authChecked && canSeeUsage && (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3 max-w-xl">
            <TabsTrigger value="usage" className="gap-1.5">
              <BarChart3 className="h-4 w-4" />
              Usage
            </TabsTrigger>
            <TabsTrigger value="global" className="gap-1.5">
              <Globe className="h-4 w-4" />
              Global
            </TabsTrigger>
            <TabsTrigger value="plugins" className="gap-1.5">
              <Puzzle className="h-4 w-4" />
              Plugins
            </TabsTrigger>
          </TabsList>

          <TabsContent value="usage" className="mt-6 space-y-6">
            <div className="flex justify-end">
              <LastUpdated ts={userStatsUpdatedAt} spinning={userStatsSpinning} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
            </div>

            <UsageChart data={userChartData} loading={userStatsLoading} />

            {!userStatsLoading && userStats?.modelUsage && userStats.modelUsage.length > 0 ? (
              <ModelUsagePieChart
                data={userStats.modelUsage.map(m => {
                  const provider = extractProvider(m.model_name) || resolveProvider(m.model_name, '')
                  return {
                    name: getDisplayName(m.model_name),
                    value: m.requests ?? 0,
                    percentage: m.percentage || '0',
                    provider,
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

            <RequestsTable requestsTable={requestsTable} />
          </TabsContent>

          <TabsContent value="global" className="mt-6 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Globe className="h-5 w-5 text-primary" />
                    Global Usage
                  </CardTitle>
                  <CardDescription>
                    Aggregate activity across the gateway. No personal information is shown.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                    <StatCard
                      title="Active Users (30d)"
                      value={<PrettyAmount amountFormatted={globalStatsLoading ? '...' : (globalStats?.activeUsers ?? 0)} size="2xl" normalPrecision={0} />}
                      icon={Users}
                    />
                    <StatCard
                      title="Total Users"
                      value={<PrettyAmount amountFormatted={globalStatsLoading ? '...' : (globalStats?.totalUsers ?? 0)} size="2xl" normalPrecision={0} />}
                      icon={Users}
                    />
                    <StatCard
                      title="API Keys"
                      value={<PrettyAmount amountFormatted={globalStatsLoading ? '...' : (globalStats?.totalKeys ?? 0)} size="2xl" normalPrecision={0} />}
                      icon={Key}
                    />
                    <StatCard
                      title="Requests"
                      value={<PrettyAmount amountFormatted={globalStatsLoading ? '...' : (globalStats?.requests ?? 0)} size="2xl" />}
                      icon={Activity}
                    />
                    <StatCard
                      title="Tokens"
                      value={<PrettyAmount amountFormatted={globalStatsLoading ? '...' : (globalStats?.tokens ?? 0)} size="2xl" />}
                      icon={Zap}
                    />
                  </div>
                </CardContent>
              </Card>

              <UsageChart
                data={globalStats?.dailyRequests ?? []}
                loading={globalStatsLoading}
                title="Gateway Requests Over Time"
                description="Daily API request volume across all users"
              />

              {!globalStatsLoading && globalStats?.modelUsage && globalStats.modelUsage.length > 0 ? (
                <ModelUsagePieChart
                  data={globalStats.modelUsage.map(m => {
                    const provider = extractProvider(m.model_name) || resolveProvider(m.model_name, '')
                    return {
                      name: getDisplayName(m.model_name),
                      value: m.requests ?? 0,
                      percentage: m.percentage || '0',
                      provider,
                      providerName: formatProviderName(provider),
                    }
                  })}
                />
              ) : null}
            </TabsContent>

          <TabsContent value="plugins" className="mt-6">
            <PluginsOverview
              enabled={activeTab === 'plugins'}
              isAdmin={currentUser?.role === 'admin'}
            />
          </TabsContent>
        </Tabs>
      )}

      {!isLoggedIn && authChecked && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-8 gap-3">
            <TrendingUp className="w-10 h-10 text-muted-foreground opacity-40" />
            <p className="text-sm text-muted-foreground text-center">
              <a href="/" className="text-primary font-medium hover:underline">Sign in</a> to see your personal usage stats and usage chart.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
