import React, { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Activity, Key, DollarSign, TrendingUp, RefreshCw } from 'lucide-react'
import { PrettyAmount } from '@/components/PrettyAmount'
import { PrettyDate } from '@/components/PrettyDate'

async function fetchUserStats() {
  const res = await fetch('/api/dashboard/user-stats', {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

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
  const { data: user, isLoading, error, dataUpdatedAt, isFetching } = useQuery({
    queryKey: ['dashboard', 'user-stats'],
    queryFn: fetchUserStats,
    refetchInterval: 60_000,        // 60s polling — silent background refresh
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
      color: 'text-blue-500',
    },
    {
      title: 'Your Tokens',
      value: <PrettyAmount amountFormatted={user?.tokens ?? 0} size="2xl" />,
      change: user?.tokensChange || '+0%',
      icon: Key,
      color: 'text-green-500',
    },
    {
      title: 'Your Spend',
      value: <PrettyAmount amountFormatted={user?.spend ?? 0} size="2xl" usd={String(user?.spend ?? 0)} usdInline />,
      change: user?.spendChange || '+0%',
      icon: DollarSign,
      color: 'text-amber-500',
    },
    {
      title: 'Active Keys',
      value: <PrettyAmount amountFormatted={user?.keys ?? 0} size="2xl" normalPrecision={0} />,
      change: user?.keysChange || '0',
      icon: TrendingUp,
      color: 'text-purple-500',
    },
  ]

  const requestHistory = user?.requestHistory || []

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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
                <TrendingUp className="mr-1 h-3 w-3 text-green-500" />
                <span className="text-green-500">{stat.change}</span>
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
          <div className="h-[300px] sm:h-[400px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={requestHistory.length > 0 ? requestHistory : []}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" className="text-xs" />
                <YAxis className="text-xs" />
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
                  stroke="hsl(222.2 47.4% 11.2%)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
            {requestHistory.length === 0 && (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                {isLoading ? 'Loading...' : 'No request history available'}
              </div>
            )}
          </div>
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
                  <TableHead>Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : user?.modelUsage?.length > 0 ? (
                  user.modelUsage.map((model: any, i: number) => {
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
                        <TableCell><PrettyAmount amountFormatted={model.cost ?? 0} size="sm" usd={String(model.cost ?? 0)} /></TableCell>
                      </TableRow>
                    )
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
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
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : user?.keys?.length > 0 ? (
                  user.keys.map((key: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{key.name || 'API Key'}</TableCell>
                      <TableCell><PrettyDate date={key.createdAt} format="date" size="sm" /></TableCell>
                      <TableCell>
                        <Badge variant={key.revoked ? 'destructive' : 'success'}>
                          {key.revoked ? 'Revoked' : 'Active'}
                        </Badge>
                      </TableCell>
                      <TableCell><PrettyAmount amountFormatted={key.requests ?? 0} size="sm" /></TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
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
