import { useQuery } from '@tanstack/react-query'
import { useState, useEffect, useCallback, useRef } from 'react'
import { queryKeys } from '@/lib/query-keys'
import type { GroupedRequest } from '@/components/StackedRequestItem'

// ── Types ────────────────────────────────────────────────────────────────────

export interface PaginationMeta {
  page: number
  pageSize: number
  totalGroups: number
  hasMore: boolean
  hasExactTotal: boolean
  totalRequests: number
}

export interface GroupedRequestsResponse {
  groups: GroupedRequest[]
  pagination: PaginationMeta
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

// ── Fetch helpers (internal) ─────────────────────────────────────────────────

const PAGE_SIZE = 20

async function fetchGroupedRequests(page: number): Promise<GroupedRequestsResponse> {
  const res = await fetch(
    `/api/overview/requests/grouped?page=${page}&pageSize=${PAGE_SIZE}`,
    { credentials: 'include' },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchGroupItems(group: GroupedRequest): Promise<ApiRequestItem[]> {
  if (!group.model || !group.firstTimestamp || !group.lastTimestamp) return []

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

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useGroupedRequests(page: number) {
  return useQuery({
    queryKey: queryKeys.groupedRequests(page),
    queryFn: () => fetchGroupedRequests(page),
    refetchInterval: (query) => query.state.error ? false : (page === 1 ? 10_000 : false),
    staleTime: 5_000,
  })
}

export function useGroupItems(group: GroupedRequest, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.groupItems(group.id),
    queryFn: () => fetchGroupItems(group),
    enabled,
    staleTime: 60_000,
  })
}

// ── useRequestsTable: manages page + allGroups accumulation ───────────────────

export function useRequestsTable() {
  const [page, setPage] = useState(1)
  const [allGroups, setAllGroups] = useState<GroupedRequest[]>([])
  const [pagination, setPagination] = useState<PaginationMeta | null>(null)
  const mergedPages = useRef<Set<number>>(new Set())

  const query = useGroupedRequests(page)
  const { data, isFetching, refetch } = query

  useEffect(() => {
    if (!data) return
    const incomingPage = data.pagination.page
    if (incomingPage === 1) {
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

  return { ...query, allGroups, pagination, handleLoadMore, handleRetry }
}

export type UseRequestsTableReturn = ReturnType<typeof useRequestsTable>
export type UseGroupedRequestsReturn = ReturnType<typeof useGroupedRequests>
export type UseGroupItemsReturn = ReturnType<typeof useGroupItems>
