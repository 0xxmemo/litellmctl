import { useState, useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts'
import { Calendar, Download } from 'lucide-react'
import { useUserStatsAnalytics } from '@/hooks/useStats'

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8']

export function UsageAnalytics() {
  const [dateRange, setDateRange] = useState('7d')

  const { data: rawData, isLoading: loading } = useUserStatsAnalytics()

  const analytics = useMemo(() => {
    if (!rawData) return { requests: [], models: [], endpoints: [] }
    return {
      requests: [{ date: new Date().toISOString().split('T')[0], requests: rawData.requests }],
      models: rawData.modelUsage || [],
      endpoints: [],
    }
  }, [rawData])

  const costData = useMemo(() => {
    if (!rawData?.modelUsage || rawData.modelUsage.length === 0) return []
    const totalCost = rawData.modelUsage.reduce((sum: number, m: any) => sum + (m.spend || 0), 0)
    return rawData.modelUsage.map((m: any) => ({
      category: m.model_name?.split('-')[0] || m.model_name || 'Unknown',
      amount: m.spend || 0,
      percentage: totalCost > 0 ? ((m.spend / totalCost) * 100).toFixed(1) : '0'
    }))
  }, [rawData])

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header - Responsive */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Usage Analytics</h2>
          <p className="text-muted-foreground">Detailed insights into your API usage</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="w-full sm:w-auto">
            <Calendar className="mr-2 h-4 w-4" />
            {dateRange === '7d' ? 'Last 7 days' : dateRange === '30d' ? 'Last 30 days' : 'Last 90 days'}
          </Button>
          <Button variant="outline" size="sm" className="w-full sm:w-auto">
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      {/* Date Range Selector - Responsive */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={dateRange === '7d' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDateRange('7d')}
          className="flex-1 sm:flex-none"
        >
          7D
        </Button>
        <Button
          variant={dateRange === '30d' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDateRange('30d')}
          className="flex-1 sm:flex-none"
        >
          30D
        </Button>
        <Button
          variant={dateRange === '90d' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDateRange('90d')}
          className="flex-1 sm:flex-none"
        >
          90D
        </Button>
      </div>

      {/* Requests Over Time - Responsive */}
      <Card className="h-full">
        <CardHeader>
          <CardTitle>Requests Over Time</CardTitle>
          <CardDescription>Daily API request volume</CardDescription>
        </CardHeader>
        <CardContent className="h-full">
          <div className="h-[300px] sm:h-[400px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={analytics.requests}>
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
                <Legend />
                <Line
                  type="monotone"
                  dataKey="requests"
                  stroke="hsl(222.2 47.4% 11.2%)"
                  strokeWidth={2}
                  dot={false}
                  name="Requests"
                />
                <Line
                  type="monotone"
                  dataKey="tokens"
                  stroke="hsl(210 40% 98%)"
                  strokeWidth={2}
                  dot={false}
                  name="Tokens"
                />
              </LineChart>
            </ResponsiveContainer>
            {analytics.requests.length === 0 && (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                {loading ? 'Loading chart data...' : 'No data available'}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Token Usage by Model & Top Endpoints - Responsive Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="h-full">
          <CardHeader>
            <CardTitle>Token Usage by Model</CardTitle>
            <CardDescription>Distribution across AI models</CardDescription>
          </CardHeader>
          <CardContent className="h-full">
            <div className="h-[250px] sm:h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.models}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="model" className="text-xs" tick={{fontSize: 10}} angle={-45} textAnchor="end" height={60} />
                  <YAxis className="text-xs" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                    }}
                  />
                  <Bar dataKey="tokens" fill="hsl(222.2 47.4% 11.2%)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              {analytics.models.length === 0 && (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  {loading ? 'Loading...' : 'No model data'}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle>Top Endpoints</CardTitle>
            <CardDescription>Most used API endpoints</CardDescription>
          </CardHeader>
          <CardContent className="h-full">
            <div className="space-y-4">
              {analytics.endpoints && analytics.endpoints.length > 0 ? (
                analytics.endpoints.map((item: any) => (
                  <div key={item.endpoint} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{item.endpoint}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{(item.requests || 0).toLocaleString()}</Badge>
                        <span className="text-muted-foreground w-12 text-right">{item.percentage}%</span>
                      </div>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${item.percentage}%` }}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-muted-foreground text-center py-8">
                  {loading ? 'Loading...' : 'No endpoint data'}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Cost Breakdown & Model Costs - Responsive Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="h-full">
          <CardHeader>
            <CardTitle>Cost Breakdown</CardTitle>
            <CardDescription>Where your budget goes</CardDescription>
          </CardHeader>
          <CardContent className="h-full">
            <div className="h-[250px] sm:h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={costData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ category, percentage }: any) => `${category}: ${percentage}%`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="amount"
                  >
                    {costData.map((_entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              {costData.length === 0 && (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  {loading ? 'Loading cost data...' : 'No cost data'}
                </div>
              )}
            </div>
            <div className="mt-4 space-y-2">
              {costData.length > 0 ? (
                costData.map((item: any, i: number) => (
                  <div key={item.category} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: COLORS[i] }}
                      />
                      <span>{item.category}</span>
                    </div>
                    <span className="font-medium">${(item.amount ?? 0).toFixed(2)} ({item.percentage}%)</span>
                  </div>
                ))
              ) : (
                <div className="text-muted-foreground text-center py-4">
                  {loading ? 'Loading...' : 'No cost data available'}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle>Model Costs</CardTitle>
            <CardDescription>Cost per AI model</CardDescription>
          </CardHeader>
          <CardContent className="h-full">
            <div className="space-y-4">
              {analytics.models.length > 0 ? (
                analytics.models.map((item: any, i: number) => (
                  <div key={item.model} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                    <div className="flex items-center gap-3">
                      <div
                        className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
                        style={{ backgroundColor: `${COLORS[i]}20` }}
                      >
                        <div
                          className="h-4 w-4 rounded-full"
                          style={{ backgroundColor: COLORS[i] }}
                        />
                      </div>
                      <div>
                        <p className="font-medium">{item.model}</p>
                        <p className="text-xs text-muted-foreground">
                          {((item.tokens ?? 0) / 1000).toFixed(0)}K tokens
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">${(item.cost ?? 0).toFixed(2)}</p>
                      <p className="text-xs text-muted-foreground">
                        ${((item.tokens ?? 0) > 0 ? (item.cost ?? 0) / ((item.tokens ?? 0) / 1000) : 0).toFixed(4)}/1K
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-muted-foreground text-center py-8">
                  {loading ? 'Loading...' : 'No model cost data'}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
