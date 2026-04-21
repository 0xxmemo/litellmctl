import { useState, useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Calendar, Download } from 'lucide-react'
import { useUserStatsAnalytics } from '@/hooks/use-stats'

const requestsTimeConfig = {
  requests: { label: 'Requests', color: 'var(--chart-1)' },
} satisfies ChartConfig

const tokensByModelConfig = {
  tokens: { label: 'Tokens', color: 'var(--chart-2)' },
} satisfies ChartConfig

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
          {analytics.requests.length === 0 ? (
            <div className="flex h-[300px] sm:h-[400px] items-center justify-center text-muted-foreground">
              {loading ? 'Loading chart data...' : 'No data available'}
            </div>
          ) : (
            <ChartContainer
              config={requestsTimeConfig}
              className="h-[300px] sm:h-[400px] w-full min-h-[300px]"
            >
              <LineChart
                accessibilityLayer
                data={analytics.requests}
                margin={{ left: 8, right: 8, top: 8, bottom: 4 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11 }} />
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

      {/* Token Usage by Model & Top Endpoints - Responsive Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="h-full">
          <CardHeader>
            <CardTitle>Token Usage by Model</CardTitle>
            <CardDescription>Distribution across AI models</CardDescription>
          </CardHeader>
          <CardContent className="h-full">
            {analytics.models.length === 0 ? (
              <div className="flex h-[250px] sm:h-[300px] items-center justify-center text-muted-foreground">
                {loading ? 'Loading...' : 'No model data'}
              </div>
            ) : (
              <ChartContainer
                config={tokensByModelConfig}
                className="h-[250px] sm:h-[300px] w-full min-h-[250px]"
              >
                <BarChart
                  accessibilityLayer
                  data={analytics.models}
                  margin={{ left: 8, right: 8, top: 8, bottom: 48 }}
                >
                  <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="model"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 10 }}
                    angle={-35}
                    textAnchor="end"
                    height={70}
                  />
                  <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={44} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="tokens" fill="var(--color-tokens)" radius={[5, 5, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
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

    </div>
  )
}
