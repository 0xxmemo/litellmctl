'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Activity, Loader2, ChevronDown } from 'lucide-react'
import { StackedRequestItem, GroupedRequest } from '@/components/StackedRequestItem'

interface PaginationMeta {
  page: number
  pageSize: number
  totalGroups: number
  totalPages: number
  hasMore: boolean
  totalRequests: number
}

interface GroupedRequestsResponse {
  groups: GroupedRequest[]
  pagination: PaginationMeta
}

const PAGE_SIZE = 20

async function fetchGroupedRequests(page: number): Promise<GroupedRequestsResponse> {
  const res = await fetch(
    `/api/overview/requests/grouped?page=${page}&pageSize=${PAGE_SIZE}`,
    { credentials: 'include' }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

interface RequestsTableProps {
  className?: string
}

export function RequestsTable({ className }: RequestsTableProps) {
  const [page, setPage] = useState(1)
  const [allGroups, setAllGroups] = useState<GroupedRequest[]>([])
  const [pagination, setPagination] = useState<PaginationMeta | null>(null)
  // track which pages we've already merged to avoid double-appending on re-renders
  const mergedPages = useRef<Set<number>>(new Set())

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['overview', 'grouped-requests', page],
    queryFn: () => fetchGroupedRequests(page),
    // auto-refresh only on page 1, stop on error to avoid loading loop
    refetchInterval: (query) => query.state.error ? false : (page === 1 ? 10_000 : false),
    staleTime: 5_000,
  })

  // Merge incoming page data into allGroups
  useEffect(() => {
    if (!data) return
    const incomingPage = data.pagination.page

    if (incomingPage === 1) {
      // Full reset on page 1 (initial load / auto-refresh)
      mergedPages.current = new Set([1])
      setAllGroups(data.groups)
    } else if (!mergedPages.current.has(incomingPage)) {
      mergedPages.current.add(incomingPage)
      setAllGroups(prev => {
        const existingIds = new Set(prev.map(g => g.id))
        const newGroups = data.groups.filter(g => !existingIds.has(g.id))
        return [...prev, ...newGroups]
      })
    }

    setPagination(data.pagination)
  }, [data])

  const handleLoadMore = useCallback(() => {
    if (pagination?.hasMore && !isFetching) {
      setPage(prev => prev + 1)
    }
  }, [pagination?.hasMore, isFetching])

  const handleRetry = useCallback(() => {
    mergedPages.current = new Set()
    setPage(1)
    setAllGroups([])
    setPagination(null)
    refetch()
  }, [refetch])

  const showingCount = allGroups.length
  const totalGroups = pagination?.totalGroups ?? 0

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          Recent Requests
          {isFetching && !isLoading && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
          )}
        </CardTitle>
        <CardDescription className="flex items-center justify-between">
          <span>Your API calls, grouped by model — click stacked rows to expand</span>
          {pagination && totalGroups > 0 && (
            <span className="text-xs tabular-nums">
              Showing {showingCount} of {totalGroups} groups
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isLoading && allGroups.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading requests…</span>
          </div>
        ) : error && allGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground px-4">
            <Activity className="w-8 h-8 opacity-30" />
            <p className="text-sm">Failed to load requests</p>
            <Button variant="outline" size="sm" onClick={handleRetry}>
              Retry
            </Button>
          </div>
        ) : allGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
            <Activity className="w-10 h-10 opacity-20" />
            <p className="text-sm font-medium">No requests yet</p>
            <p className="text-xs">Your API calls will appear here</p>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-6">Model</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead className="text-right">In</TableHead>
                  <TableHead className="text-right">Out</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right pr-6">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allGroups.map((group) => (
                  <StackedRequestItem key={group.id} group={group} />
                ))}
              </TableBody>
            </Table>

            {/* Load More / pagination footer */}
            {pagination && (
              <div className="flex items-center justify-center py-4 border-t border-border/50">
                {pagination.hasMore ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleLoadMore}
                    disabled={isFetching}
                    className="gap-1.5 text-muted-foreground hover:text-foreground"
                  >
                    {isFetching ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Loading…
                      </>
                    ) : (
                      <>
                        <ChevronDown className="w-3.5 h-3.5" />
                        Load more ({totalGroups - showingCount} remaining)
                      </>
                    )}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    All {totalGroups} groups loaded
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
