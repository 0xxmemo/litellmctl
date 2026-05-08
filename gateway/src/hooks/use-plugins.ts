import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

// ── Types ────────────────────────────────────────────────────────────────────

export interface Plugin {
  name: string
  slug: string
  description: string
  type: string
  installUrl: string
  docsUrl: string
}

export interface PluginsResponse {
  plugins: Plugin[]
}

export interface PluginTarget {
  id: string
  name: string
  settingsDir: string
  configVar: string
}

export interface PluginTargetsResponse {
  targets: PluginTarget[]
}

// ── Fetch helpers (internal) ─────────────────────────────────────────────────

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

async function fetchPlugins(): Promise<Plugin[]> {
  const res = await apiFetch('/api/plugins')
  const data: PluginsResponse = await res.json()
  return data.plugins ?? []
}

async function fetchPluginTargets(): Promise<PluginTarget[]> {
  const res = await apiFetch('/api/plugins/targets')
  const data: PluginTargetsResponse = await res.json()
  return data.targets ?? []
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function usePlugins() {
  return useQuery({
    queryKey: queryKeys.plugins,
    queryFn: fetchPlugins,
  })
}

export type UsePluginsReturn = ReturnType<typeof usePlugins>

export function usePluginTargets() {
  return useQuery({
    queryKey: queryKeys.pluginsTargets,
    queryFn: fetchPluginTargets,
  })
}

export type UsePluginTargetsReturn = ReturnType<typeof usePluginTargets>

// ── Plugin usage / monitoring ────────────────────────────────────────────────

export interface ClaudeContextBranch {
  branch: string
  status: 'indexing' | 'indexed' | 'failed' | 'cancelled'
  percentage: number
  headCommit: string | null
  totalFiles: number | null
  indexedFiles: number | null
  totalChunks: number | null
  updatedAt: number
}

export interface ClaudeContextCollection {
  name: string
  codebaseId: string | null
  dimension: number
  createdAt: number
  chunks: number
  files: number
  hidden?: boolean
  branches: ClaudeContextBranch[]
}

export interface ClaudeContextIndexingJob {
  codebaseId: string
  branch: string
  collection: string
  status: 'indexing' | 'failed' | 'cancelled'
  percentage: number
  headCommit: string | null
  error: string | null
  totalFiles: number | null
  indexedFiles: number | null
  totalChunks: number | null
  updatedAt: number
  hidden?: boolean
}

export interface ClaudeContextUsage {
  totals: { codebases: number; chunks: number; files: number }
  collections: ClaudeContextCollection[]
  indexing: ClaudeContextIndexingJob[]
}

export interface SupermemoryEntry {
  id: string
  content: string
  createdAt: string | null
  source: string | null
  project: string
}

export interface SupermemoryUsage {
  exists: boolean
  total: number
  createdAt?: number
  dimension?: number
  project?: string | null
  memories: SupermemoryEntry[]
}

async function fetchClaudeContextUsage(): Promise<ClaudeContextUsage> {
  const res = await apiFetch('/api/plugins/claude-context/usage')
  return (await res.json()) as ClaudeContextUsage
}

async function fetchSupermemoryUsage(limit: number, project?: string): Promise<SupermemoryUsage> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (project) params.set('project', project)
  const res = await apiFetch(`/api/plugins/supermemory/usage?${params.toString()}`)
  return (await res.json()) as SupermemoryUsage
}

// Polling cadence shared by every plugin overview query: 3 s burst while a
// long-running job (indexing, crawling) is in flight so progress feels live;
// 30 s idle otherwise so the freshness indicator on the page stays honest
// without hammering the gateway. `refetchIntervalInBackground` defaults to
// false → polling pauses when the tab loses focus.
const PLUGIN_IDLE_POLL_MS = 30_000
const PLUGIN_ACTIVE_POLL_MS = 3_000

export function useClaudeContextUsage(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.claudeContextUsage,
    queryFn: fetchClaudeContextUsage,
    enabled: options?.enabled ?? true,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.indexing?.length
        ? PLUGIN_ACTIVE_POLL_MS
        : PLUGIN_IDLE_POLL_MS,
  })
}

export type UseClaudeContextUsageReturn = ReturnType<typeof useClaudeContextUsage>

// Admin-only destructive actions. Backend enforces the role check; the UI
// only gates button visibility.

async function deleteCodebaseApi(codebaseId: string): Promise<void> {
  const res = await fetch(
    `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(codebaseId)}`,
    { method: 'DELETE', credentials: 'include' },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function cancelJobApi(params: { codebaseId: string; branch?: string }): Promise<void> {
  const res = await fetch('/api/plugins/claude-context/jobs/cancel', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function clearJobApi(params: { codebaseId: string; branch: string }): Promise<void> {
  const qs = `codebaseId=${encodeURIComponent(params.codebaseId)}&branch=${encodeURIComponent(params.branch)}`
  const res = await fetch(`/api/plugins/claude-context/jobs?${qs}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

export function useRemoveClaudeContextCodebase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deleteCodebaseApi,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.claudeContextUsage }),
  })
}

export type UseRemoveClaudeContextCodebaseReturn = ReturnType<typeof useRemoveClaudeContextCodebase>

export function useStopClaudeContextJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: cancelJobApi,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.claudeContextUsage }),
  })
}

export type UseStopClaudeContextJobReturn = ReturnType<typeof useStopClaudeContextJob>

export function useClearClaudeContextJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: clearJobApi,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.claudeContextUsage }),
  })
}

export type UseClearClaudeContextJobReturn = ReturnType<typeof useClearClaudeContextJob>

async function hideCodebaseApi(codebaseId: string): Promise<void> {
  const res = await fetch('/api/plugins/claude-context/hidden', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codebaseId }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function unhideCodebaseApi(codebaseId: string): Promise<void> {
  const res = await fetch(
    `/api/plugins/claude-context/hidden?codebaseId=${encodeURIComponent(codebaseId)}`,
    { method: 'DELETE', credentials: 'include' },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

export function useHideClaudeContextCodebase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: hideCodebaseApi,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.claudeContextUsage }),
  })
}

export type UseHideClaudeContextCodebaseReturn = ReturnType<typeof useHideClaudeContextCodebase>

export function useUnhideClaudeContextCodebase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: unhideCodebaseApi,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.claudeContextUsage }),
  })
}

export type UseUnhideClaudeContextCodebaseReturn = ReturnType<typeof useUnhideClaudeContextCodebase>

// ── Docs Context (parallel pipeline to claude-context, scoped to docs sources) ─

export interface DocsContextSource {
  sourceId: string
  baseUrl: string
  ref: string
  collection: string
  pages: number
  chunks: number
  updatedAt: number
  hidden?: boolean
}

export interface DocsContextIndexingJob {
  sourceId: string
  ref: string
  baseUrl: string
  status: 'indexing' | 'failed' | 'cancelled'
  percentage: number
  pagesTotal: number | null
  pagesIndexed: number | null
  totalChunks: number | null
  error: string | null
  updatedAt: number
  hidden?: boolean
}

export interface DocsContextUsage {
  totals: { sources: number; pages: number; chunks: number }
  sources: DocsContextSource[]
  indexing: DocsContextIndexingJob[]
}

async function fetchDocsContextUsage(): Promise<DocsContextUsage> {
  const res = await apiFetch('/api/plugins/docs-context/usage')
  return (await res.json()) as DocsContextUsage
}

export function useDocsContextUsage(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.docsContextUsage,
    queryFn: fetchDocsContextUsage,
    enabled: options?.enabled ?? true,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.indexing?.length
        ? PLUGIN_ACTIVE_POLL_MS
        : PLUGIN_IDLE_POLL_MS,
  })
}

export type UseDocsContextUsageReturn = ReturnType<typeof useDocsContextUsage>

async function deleteDocsSourceApi(sourceId: string): Promise<void> {
  const res = await fetch(
    `/api/plugins/docs-context/jobs?sourceId=${encodeURIComponent(sourceId)}`,
    { method: 'DELETE', credentials: 'include' },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function cancelDocsJobApi(params: { sourceId: string; ref?: string }): Promise<void> {
  const res = await fetch('/api/plugins/docs-context/jobs/cancel', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function clearDocsJobApi(params: { sourceId: string; ref: string }): Promise<void> {
  const qs = `sourceId=${encodeURIComponent(params.sourceId)}&ref=${encodeURIComponent(params.ref)}`
  const res = await fetch(`/api/plugins/docs-context/jobs?${qs}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function hideDocsSourceApi(sourceId: string): Promise<void> {
  const res = await fetch('/api/plugins/docs-context/hidden', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function unhideDocsSourceApi(sourceId: string): Promise<void> {
  const res = await fetch(
    `/api/plugins/docs-context/hidden?sourceId=${encodeURIComponent(sourceId)}`,
    { method: 'DELETE', credentials: 'include' },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

export function useRemoveDocsContextSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deleteDocsSourceApi,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.docsContextUsage }),
  })
}
export type UseRemoveDocsContextSourceReturn = ReturnType<typeof useRemoveDocsContextSource>

export function useStopDocsContextJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: cancelDocsJobApi,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.docsContextUsage }),
  })
}
export type UseStopDocsContextJobReturn = ReturnType<typeof useStopDocsContextJob>

export function useClearDocsContextJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: clearDocsJobApi,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.docsContextUsage }),
  })
}
export type UseClearDocsContextJobReturn = ReturnType<typeof useClearDocsContextJob>

export function useHideDocsContextSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: hideDocsSourceApi,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.docsContextUsage }),
  })
}
export type UseHideDocsContextSourceReturn = ReturnType<typeof useHideDocsContextSource>

export function useUnhideDocsContextSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: unhideDocsSourceApi,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.docsContextUsage }),
  })
}
export type UseUnhideDocsContextSourceReturn = ReturnType<typeof useUnhideDocsContextSource>

export function useSupermemoryUsage(
  limit = 20,
  options?: { enabled?: boolean; project?: string },
) {
  const project = options?.project
  return useQuery({
    queryKey: queryKeys.supermemoryUsage(limit, project),
    queryFn: () => fetchSupermemoryUsage(limit, project),
    enabled: options?.enabled ?? true,
    refetchOnWindowFocus: false,
    // Supermemory has no long-running jobs to burst-poll for, but the user
    // can save/forget memories from another tab — idle polling keeps the
    // overview honest.
    refetchInterval: PLUGIN_IDLE_POLL_MS,
  })
}

export type UseSupermemoryUsageReturn = ReturnType<typeof useSupermemoryUsage>

async function forgetSupermemoryApi(ids: string[]): Promise<{ deleted: number }> {
  if (ids.length === 0) return { deleted: 0 }
  const res = await fetch('/api/plugins/supermemory/forget', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as { deleted: number }
}

export function useForgetSupermemoryMemories() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: forgetSupermemoryApi,
    // The query key embeds (limit, project), so multiple variants may be in
    // the cache. Invalidate every supermemoryUsage entry so any open view
    // refetches after a delete.
    onSuccess: () =>
      qc.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          q.queryKey[0] === 'plugins' &&
          q.queryKey[1] === 'supermemory' &&
          q.queryKey[2] === 'usage',
      }),
  })
}

export type UseForgetSupermemoryMemoriesReturn = ReturnType<typeof useForgetSupermemoryMemories>
