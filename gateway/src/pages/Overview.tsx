'use client'
import { useEffect, useState } from 'react'
import { StatCard } from '@/components/StatCard'
import { Activity, Key, Zap, TrendingUp, RefreshCw, Puzzle, BarChart3 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PrettyAmount } from '@/components/PrettyAmount'
import { ModelUsagePieChart } from '@/components/ModelUsagePieChart'
import { RequestsTable } from '@/components/RequestsTable'
import { PluginsOverview } from '@/components/plugins/PluginsOverview'
import { getDisplayName, formatProviderName, getProviderColor, extractProvider, resolveProvider } from '@lib/models'
import { useUserStats } from '@/hooks/useStats'
import { useAuth } from '@/hooks/useAuth'
import { useRequestsTable } from '@/hooks/useRequests'
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

  const rateLimited = false // react-query retry handles backoff

  const userChartData = buildUserChart(userStats)

  const [activeTab, setActiveTab] = useState<string>('usage')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Overview</h1>
      </div>

      {rateLimited && (
        <div className="flex items-center gap-2 rounded-md border border-yellow-400/40 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-700 dark:text-yellow-300">
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
          <TabsList className="grid w-full grid-cols-2 max-w-md">
            <TabsTrigger value="usage" className="gap-1.5">
              <BarChart3 className="h-4 w-4" />
              Usage
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

            <RequestsTable requestsTable={requestsTable} />
          </TabsContent>

          <TabsContent value="plugins" className="mt-6">
            <PluginsOverview enabled={activeTab === 'plugins'} />
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
