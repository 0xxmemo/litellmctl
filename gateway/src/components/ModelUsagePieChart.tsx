import { useState } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatProviderName, getProviderColor, extractProvider, resolveProvider } from '@lib/models'

const COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4', '#f97316']

interface ModelUsagePieChartProps {
  data: Array<{
    name: string
    value: number
    percentage: string | number
    requested_aliases?: string[]
    provider?: string
    colorClass?: string
    providerName?: string
  }>
}

/** Strip provider prefix from model name for compact display */
function shortModelName(name: string): string {
  const parts = name.split('/')
  return parts[parts.length - 1] ?? name
}

export function ModelUsagePieChart({ data }: ModelUsagePieChartProps) {
  const [legendExpanded, setLegendExpanded] = useState(false)

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

  const renderCustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percentage }: any) => {
    const RADIAN = Math.PI / 180
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5
    const x = cx + radius * Math.cos(-midAngle * RADIAN)
    const y = cy + radius * Math.sin(-midAngle * RADIAN)
    const pct = typeof percentage === 'number' && isFinite(percentage) ? percentage : 0
    if (pct < 8) return null
    return (
      <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={600}>
        {`${pct.toFixed(0)}%`}
      </text>
    )
  }

  // Custom compact legend — 2 columns on desktop, 1 on mobile
  const MOBILE_SHOW = 5
  const visibleItems = legendExpanded ? data : data.slice(0, MOBILE_SHOW)
  const hasMore = data.length > MOBILE_SHOW

  const CustomLegend = () => (
    <div className="mt-3">
      {/* Grid legend: 2 cols on sm+, 1 col on xs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {/* On mobile show only first MOBILE_SHOW unless expanded */}
        {(legendExpanded ? data : visibleItems).map((entry, index) => (
          <div
            key={`${entry.name}-${index}`}
            className="flex items-center gap-1.5 min-w-0"
            title={entry.name}
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
              style={{ backgroundColor: COLORS[index % COLORS.length] }}
            />
            <span className="text-xs text-muted-foreground truncate leading-tight">
              {shortModelName(entry.name)}
            </span>
            <span className="text-xs text-muted-foreground/60 flex-shrink-0 ml-auto pl-1">
              {entry.percentage}%
            </span>
          </div>
        ))}
      </div>

      {/* Show "N more" toggle on mobile */}
      {hasMore && (
        <button
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
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={renderCustomLabel}
              outerRadius={95}
              fill="#8884d8"
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`${entry.name}-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip 
              formatter={((value: number | undefined, name: string | undefined, props: any) => [
                `${(value ?? 0).toLocaleString()} (${props?.payload?.percentage ?? '0'}%)`,
                props?.payload?.name ?? name
              ]) as any}
              contentStyle={{
                backgroundColor: 'rgba(0, 0, 0, 0.75)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '10px',
                fontSize: '13px',
                color: '#f1f5f9',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
              }}
              labelStyle={{ color: '#e2e8f0', fontWeight: 600, marginBottom: '4px' }}
              itemStyle={{ color: '#cbd5e1' }}
            />
          </PieChart>
        </ResponsiveContainer>

        {/* Compact custom legend */}
        <CustomLegend />
        
        {/* Stats table — compact + responsive + scrollable */}
        <div className="mt-4 -mx-1">
          <div className="max-h-64 sm:max-h-80 overflow-y-auto overflow-x-auto rounded-sm">
          <Table className="text-xs min-w-[340px]">
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow className="h-7">
                <TableHead className="py-1.5 pl-2 pr-1 w-auto">Model</TableHead>
                <TableHead className="py-1.5 px-2 w-16 text-right hidden sm:table-cell">Reqs</TableHead>
                <TableHead className="py-1.5 px-2 w-24 text-right">%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((model, index) => {
                const aliases = (model.requested_aliases || []).filter(a => a && a !== model.name)
                const effectiveProvider = model.provider || extractProvider(model.name) || resolveProvider(model.name, '')
                const effectiveColorClass = model.colorClass || getProviderColor(effectiveProvider)
                const effectiveProviderName = model.providerName || formatProviderName(effectiveProvider)
                const pct = typeof model.percentage === 'number' ? model.percentage : parseFloat(String(model.percentage)) || 0
                return (
                  <TableRow key={`${model.name}-${index}`} className="h-8">
                    <TableCell className="py-1 pl-2 pr-1 font-medium max-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="inline-block w-2 h-2 rounded-sm flex-shrink-0"
                          style={{ backgroundColor: COLORS[index % COLORS.length] }}
                        />
                        <span className={`text-[10px] px-1 py-px rounded border font-mono flex-shrink-0 leading-tight ${effectiveColorClass}`}>
                          {effectiveProviderName}
                        </span>
                        <span className="truncate text-xs" title={model.name}>{shortModelName(model.name)}</span>
                        {aliases.length > 0 && (
                          <span className="hidden md:inline text-[10px] text-muted-foreground/60 flex-shrink-0" title={`Requested as: ${aliases.join(', ')}`}>
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
                        <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden flex-shrink-0 hidden xs:block sm:block">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: COLORS[index % COLORS.length] }}
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
