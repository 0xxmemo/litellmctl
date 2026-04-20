import { useQuery } from '@tanstack/react-query'
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
