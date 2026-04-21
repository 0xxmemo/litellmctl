import { useMemo, useState } from 'react'
import { Label, Pie, PieChart } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { formatProviderName, getProviderBadgeClassName, extractProvider, resolveProvider } from '@lib/models'

interface ModelUsagePieChartProps {
  data: Array<{
    name: string
    value: number
    percentage: string | number
    requested_aliases?: string[]
    provider?: string
    providerName?: string
  }>
}

function shortModelName(name: string): string {
  const parts = name.split('/')
  return parts[parts.length - 1] ?? name
}

function sliceThemeColor(index: number): string {
  return `var(--chart-${(index % 5) + 1})`
}

export function ModelUsagePieChart({ data }: ModelUsagePieChartProps) {
  const [legendExpanded, setLegendExpanded] = useState(false)

  const totalRequests = useMemo(
    () => data.reduce((acc, d) => acc + (d.value ?? 0), 0),
    [data]
  )

  const { chartConfig, pieRows } = useMemo(() => {
    const cfg: ChartConfig = {
      value: { label: 'Requests' },
    }
    const rows = data.map((d, i) => {
      const sliceKey = `s${i}`
      cfg[sliceKey] = {
        label: shortModelName(d.name),
        color: sliceThemeColor(i),
      }
      return {
        sliceKey,
        value: d.value,
        percentage: d.percentage,
        name: d.name,
        requested_aliases: d.requested_aliases,
        provider: d.provider,
        providerName: d.providerName,
        fill: `var(--color-${sliceKey})`,
      }
    })
    return { chartConfig: cfg, pieRows: rows }
  }, [data])

  if (!data || data.length === 0) {
    return (
      <Card className="p-6">
        <CardHeader>
          <CardTitle>Model Usage Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-[400px] text-muted-foreground">
            No model usage data available
          </div>
        </CardContent>
      </Card>
    )
  }

  const MOBILE_SHOW = 5
  const visibleItems = legendExpanded ? data : data.slice(0, MOBILE_SHOW)
  const hasMore = data.length > MOBILE_SHOW

  const CustomLegend = () => (
    <div className="mt-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {(legendExpanded ? data : visibleItems).map((entry, index) => (
            <div
              key={`${entry.name}-${index}`}
              className="flex items-center gap-1.5 min-w-0"
              title={entry.name}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: sliceThemeColor(index) }}
              />
              <span className="text-xs text-muted-foreground truncate leading-tight">
                {shortModelName(entry.name)}
              </span>
              <span className="text-xs text-muted-foreground/60 shrink-0 ml-auto pl-1">
                {entry.percentage}%
              </span>
            </div>
        ))}
      </div>

      {hasMore && (
        <button
          type="button"
          onClick={() => setLegendExpanded(v => !v)}
          className="mt-1.5 text-xs text-muted-foreground/70 hover:text-muted-foreground transition-colors sm:hidden"
        >
          {legendExpanded ? '▲ Show less' : `▼ +${data.length - MOBILE_SHOW} more`}
        </button>
      )}
    </div>
  )

  return (
    <Card className="p-4 sm:p-6">
      <CardHeader className="pb-2 pt-0 px-0">
        <CardTitle>Model Usage Distribution</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <ChartContainer config={chartConfig} className="mx-auto aspect-square max-h-[260px] w-full">
          <PieChart>
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
            <Pie
              data={pieRows}
              dataKey="value"
              nameKey="sliceKey"
              innerRadius={56}
              outerRadius={88}
              strokeWidth={4}
            >
              <Label
                content={({ viewBox }) => {
                  if (viewBox && 'cx' in viewBox && 'cy' in viewBox) {
                    const cx = viewBox.cx ?? 0
                    const cy = viewBox.cy ?? 0
                    return (
                      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                        <tspan x={cx} y={cy} className="fill-foreground font-sans text-2xl font-bold">
                          {totalRequests.toLocaleString()}
                        </tspan>
                        <tspan x={cx} y={cy + 22} className="fill-muted-foreground font-sans text-[11px]">
                          requests
                        </tspan>
                      </text>
                    )
                  }
                }}
              />
            </Pie>
          </PieChart>
        </ChartContainer>

        <CustomLegend />

        <div className="mt-4 -mx-1">
          <div className="max-h-64 sm:max-h-80 overflow-y-auto overflow-x-auto rounded-sm">
            <Table className="text-xs min-w-[340px]">
              <TableHeader className="glass glass--muted sticky top-0 z-10 shadow-none">
                <TableRow className="h-7">
                  <TableHead className="py-1.5 pl-2 pr-1 w-auto">Model</TableHead>
                  <TableHead className="py-1.5 px-2 w-16 text-right hidden sm:table-cell">Reqs</TableHead>
                  <TableHead className="py-1.5 px-2 w-24 text-right">%</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((model, index) => {
                  const aliases = (model.requested_aliases || []).filter(a => a && a !== model.name)
                  const effectiveProvider =
                    model.provider || extractProvider(model.name) || resolveProvider(model.name, '')
                  const providerBadgeClass = getProviderBadgeClassName(effectiveProvider, 'xs')
                  const effectiveProviderName = model.providerName || formatProviderName(effectiveProvider)
                  const pct =
                    typeof model.percentage === 'number'
                      ? model.percentage
                      : parseFloat(String(model.percentage)) || 0
                  return (
                    <TableRow key={`${model.name}-${index}`} className="h-8">
                      <TableCell className="py-1 pl-2 pr-1 font-medium max-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="inline-block w-2 h-2 rounded-sm shrink-0"
                            style={{ backgroundColor: sliceThemeColor(index) }}
                          />
                          <span className={providerBadgeClass}>{effectiveProviderName}</span>
                          <span className="truncate text-xs" title={model.name}>
                            {shortModelName(model.name)}
                          </span>
                          {aliases.length > 0 && (
                            <span
                              className="hidden md:inline text-[10px] text-muted-foreground/60 shrink-0"
                              title={`Requested as: ${aliases.join(', ')}`}
                            >
                              ·{aliases.length}alias
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="py-1 px-2 text-right text-muted-foreground tabular-nums hidden sm:table-cell">
                        {model.value?.toLocaleString() ?? '0'}
                      </TableCell>
                      <TableCell className="py-1 px-2">
                        <div className="flex items-center justify-end gap-1.5">
                          <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden shrink-0 hidden xs:block sm:block">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.min(pct, 100)}%`,
                                backgroundColor: sliceThemeColor(index),
                              }}
                            />
                          </div>
                          <span className="tabular-nums text-right w-9">{pct.toFixed(1)}%</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
