import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Activity, Key, TrendingUp, RefreshCw } from 'lucide-react'
import { PrettyAmount } from '@/components/pretty-amount'
import { useUserStats } from '@/hooks/use-stats'

const requestHistoryChartConfig = {
  requests: { label: 'Requests', color: 'var(--chart-1)' },
} satisfies ChartConfig

/** Shows "Updated Xs ago" with spinning icon during background refetch */
function LastUpdated({ dataUpdatedAt, isFetching }: { dataUpdatedAt: number; isFetching: boolean }) {
  const [label, setLabel] = useState<string>('—')

  useEffect(() => {
    if (!dataUpdatedAt) return
    const tick = () => {
      const secs = Math.floor((Date.now() - dataUpdatedAt) / 1000)
      setLabel(secs < 5 ? 'just now' : `${secs}s ago`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [dataUpdatedAt])

  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground select-none">
      <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} />
      Updated {label}
    </span>
  )
}

export function UserStats() {
  const { data: user, isLoading, error, dataUpdatedAt, isFetching } = useUserStats({
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6">
            <div className="text-center text-destructive">
              <p className="text-lg font-semibold">Failed to load your usage data</p>
              <p className="text-sm text-muted-foreground">Please try again later</p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const statsData = [
    {
      title: 'Your Requests',
      value: <PrettyAmount amountFormatted={user?.requests ?? 0} size="2xl" />,
      change: user?.requestsChange || '+0%',
      icon: Activity,
      color: 'text-ui-info-fg',
    },
    {
      title: 'Your Tokens',
      value: <PrettyAmount amountFormatted={user?.tokens ?? 0} size="2xl" />,
      change: user?.tokensChange || '+0%',
      icon: Key,
      color: 'text-ui-success-fg',
    },
    {
      title: 'Active Keys',
      value: <PrettyAmount amountFormatted={user?.keys ?? 0} size="2xl" normalPrecision={0} />,
      change: user?.keysChange || '0',
      icon: TrendingUp,
      color: 'text-ui-accent-fg',
    },
  ]

  const requestHistory = user?.dailyRequests || []

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2">Your Usage</h1>
          <p className="text-muted-foreground">Personal API usage statistics and analytics</p>
        </div>
        <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} />
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {statsData.map((stat, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold flex items-baseline">
                {isLoading ? '...' : stat.value}
              </div>
              <div className="flex items-center text-xs text-muted-foreground">
                <TrendingUp className="mr-1 h-3 w-3 text-ui-success-fg" />
                <span className="text-ui-success-fg">{stat.change}</span>
                <span className="ml-1">from last month</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Request History Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Your Request History</CardTitle>
          <CardDescription>Daily API usage over the last 7 days</CardDescription>
        </CardHeader>
        <CardContent>
          {requestHistory.length === 0 ? (
            <div className="flex h-[300px] sm:h-[400px] items-center justify-center text-muted-foreground">
              {isLoading ? 'Loading...' : 'No request history available'}
            </div>
          ) : (
            <ChartContainer
              config={requestHistoryChartConfig}
              className="h-[300px] sm:h-[400px] w-full min-h-[300px]"
            >
              <LineChart
                accessibilityLayer
                data={requestHistory}
                margin={{ left: 8, right: 8, top: 8, bottom: 4 }}
              >
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

      {/* Your Model Usage */}
      <Card>
        <CardHeader>
          <CardTitle>Your Model Usage</CardTitle>
          <CardDescription>Token consumption by AI model</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Requests</TableHead>
                  <TableHead>Tokens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : (user?.modelUsage?.length ?? 0) > 0 ? (
                  user!.modelUsage!.map((model: any, i: number) => {
                    const aliases: string[] = model.requested_aliases || []
                    const hasAlias = aliases.length > 0
                    return (
                      <TableRow key={i}>
                        <TableCell className="font-medium">
                          <span title={model.model_name}>{model.model_name}</span>
                          {hasAlias && (
                            <span className="ml-1 text-xs text-muted-foreground" title={`Requested as: ${aliases.join(', ')}`}>
                              {' '}(via {aliases.join(', ')})
                            </span>
                          )}
                        </TableCell>
                        <TableCell><PrettyAmount amountFormatted={model.requests ?? 0} size="sm" /></TableCell>
                        <TableCell><PrettyAmount amountFormatted={model.tokens ?? 0} size="sm" /></TableCell>
                      </TableRow>
                    )
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      No model usage data available
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Your API Keys Summary */}
      <Card>
        <CardHeader>
          <CardTitle>Your API Keys</CardTitle>
          <CardDescription>Active and revoked keys</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      No API keys found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
