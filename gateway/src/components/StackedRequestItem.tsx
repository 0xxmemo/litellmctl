'use client'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  TableCell,
  TableRow,
} from '@/components/ui/table'
import { PrettyAmount } from '@/components/PrettyAmount'
import { PrettyDate } from '@/components/PrettyDate'
import { ChevronDown, ChevronRight, Loader2, Layers } from 'lucide-react'
import {
  getDisplayName,
  formatProviderName,
  getProviderColor,
  extractProvider,
  resolveProvider,
} from '@/lib/models'
import { cn } from '@/lib/utils'

export interface GroupedRequest {
  id: string
  provider: string
  model: string | null
  endpoint: string | null
  count: number
  totalTokens: number
  totalSpend: number
  firstTimestamp: string | Date
  lastTimestamp: string | Date
  items: ApiRequestItem[] | null
}

export interface ApiRequestItem {
  _id: string
  requestedModel: string | null
  actualModel: string | null
  endpoint: string | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
  timestamp: string | Date
}

function cleanEndpoint(endpoint: string | null): string {
  if (!endpoint) return '—'
  return endpoint.replace(/^\/v1\//, '').replace(/^\//, '')
}

function CostCell({ cost }: { cost: number }) {
  if (cost === 0 || !cost) {
    return <span className="text-muted-foreground text-xs">—</span>
  }
  return (
    <PrettyAmount
      amountFormatted={cost}
      size="sm"
      usd={String(cost)}
      usdInline
    />
  )
}

interface StackedRequestItemProps {
  group: GroupedRequest
}

async function fetchGroupItems(group: GroupedRequest): Promise<ApiRequestItem[]> {
  if (!group.model || !group.firstTimestamp || !group.lastTimestamp) return []

  // Use the broader timestamp range (from=oldest, to=newest)
  // firstTimestamp is newest (sorted desc), lastTimestamp is oldest
  const from = group.lastTimestamp
  const to = group.firstTimestamp

  const params = new URLSearchParams({
    model: group.model,
    from: String(from),
    to: String(to),
    ...(group.endpoint ? { endpoint: group.endpoint } : {}),
  })

  const res = await fetch(`/api/overview/requests/group-items?${params}`, { credentials: 'include' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.items ?? []
}

export function StackedRequestItem({ group }: StackedRequestItemProps) {
  const [expanded, setExpanded] = useState(false)
  const [items, setItems] = useState<ApiRequestItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isSingle = group.count === 1

  async function handleToggle() {
    if (isSingle) return // single items don't expand

    if (!expanded) {
      // Expand: fetch items if not already loaded
      if (!items) {
        setLoading(true)
        setError(null)
        try {
          const fetched = await fetchGroupItems(group)
          setItems(fetched)
        } catch (e) {
          setError('Failed to load')
        } finally {
          setLoading(false)
        }
      }
      setExpanded(true)
    } else {
      setExpanded(false)
    }
  }

  const model = group.model
  const provider = model
    ? (extractProvider(model) || resolveProvider(model, ''))
    : group.provider
  const colorClass = getProviderColor(provider)
  const providerLabel = formatProviderName(provider)
  const displayName = model ? getDisplayName(model) : '—'

  return (
    <>
      {/* Group header row */}
      <TableRow
        className={cn(
          'group/row',
          !isSingle && 'cursor-pointer hover:bg-muted/50 transition-colors',
          expanded && 'bg-muted/30'
        )}
        onClick={!isSingle ? handleToggle : undefined}
      >
        {/* Model column */}
        <TableCell className="pl-6">
          <div className="flex items-center gap-2">
            {!isSingle && (
              <span className="text-muted-foreground flex-shrink-0">
                {loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : expanded ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </span>
            )}
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium truncate max-w-[140px]" title={displayName}>
                  {displayName}
                </span>
                {/* Nx stacking badge */}
                {!isSingle && (
                  <Badge
                    className="text-[10px] px-1.5 py-0 h-4 bg-primary/10 text-primary border-primary/20 font-bold flex-shrink-0"
                    variant="outline"
                  >
                    {group.count}×
                  </Badge>
                )}
              </div>
              {provider && (
                <Badge
                  className={cn('text-[10px] px-1.5 py-0 border w-fit', colorClass)}
                  variant="outline"
                >
                  {providerLabel}
                </Badge>
              )}
            </div>
          </div>
        </TableCell>

        {/* Endpoint */}
        <TableCell>
          <code className="text-xs text-muted-foreground font-mono">
            {cleanEndpoint(group.endpoint)}
          </code>
        </TableCell>

        {/* Token columns — show totals for stacked, individual for single */}
        <TableCell className="text-right">
          {isSingle ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="text-right">
          <span className="text-xs text-muted-foreground">—</span>
        </TableCell>
        <TableCell className="text-right">
          <PrettyAmount
            amountFormatted={group.totalTokens}
            size="xs"
            normalPrecision={0}
          />
        </TableCell>

        {/* Cost */}
        <TableCell className="text-right">
          <CostCell cost={group.totalSpend} />
        </TableCell>

        {/* Time — show range for stacked */}
        <TableCell className="text-right pr-6">
          {!isSingle ? (
            <div className="flex flex-col items-end gap-0.5">
              <PrettyDate
                date={group.firstTimestamp}
                format="relative"
                size="xs"
                showSeconds
              />
              <span className="text-[10px] text-muted-foreground/60 flex items-center gap-0.5">
                <Layers className="w-2.5 h-2.5" />
                {group.count} calls
              </span>
            </div>
          ) : (
            <PrettyDate
              date={group.firstTimestamp}
              format="relative"
              size="xs"
              showSeconds
            />
          )}
        </TableCell>
      </TableRow>

      {/* Expanded child rows */}
      {expanded && items && items.map((item) => (
        <TableRow
          key={item._id}
          className="bg-muted/20 border-l-2 border-l-primary/20"
        >
          <TableCell className="pl-10">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground truncate max-w-[140px]">
                {item.actualModel ? getDisplayName(item.actualModel) : '—'}
              </span>
            </div>
          </TableCell>
          <TableCell>
            <code className="text-xs text-muted-foreground/70 font-mono">
              {cleanEndpoint(item.endpoint)}
            </code>
          </TableCell>
          <TableCell className="text-right">
            <PrettyAmount
              amountFormatted={item.promptTokens}
              size="xs"
              normalPrecision={0}
            />
          </TableCell>
          <TableCell className="text-right">
            <PrettyAmount
              amountFormatted={item.completionTokens}
              size="xs"
              normalPrecision={0}
            />
          </TableCell>
          <TableCell className="text-right">
            <PrettyAmount
              amountFormatted={item.totalTokens}
              size="xs"
              normalPrecision={0}
            />
          </TableCell>
          <TableCell className="text-right">
            <CostCell cost={item.cost} />
          </TableCell>
          <TableCell className="text-right pr-6">
            <PrettyDate
              date={item.timestamp}
              format="relative"
              size="xs"
              showSeconds
            />
          </TableCell>
        </TableRow>
      ))}

      {/* Error row */}
      {expanded && error && (
        <TableRow className="bg-destructive/5">
          <TableCell colSpan={7} className="text-center text-xs text-destructive py-2">
            {error}
            <Button
              variant="ghost"
              size="sm"
              className="ml-2 h-5 text-xs"
              onClick={(e) => {
                e.stopPropagation()
                setItems(null)
                handleToggle()
              }}
            >
              Retry
            </Button>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
