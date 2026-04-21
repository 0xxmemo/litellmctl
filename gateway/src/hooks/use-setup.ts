import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SetupOption {
  id: string
  name: string
  description: string
  icon: string
  scriptUrl: string
  configVar: string
  docsUrl: string
  features: string[]
  requirements: string[]
}

export interface SetupOptionsResponse {
  options: SetupOption[]
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

async function fetchSetupOptions(): Promise<SetupOption[]> {
  const res = await apiFetch('/api/setup/options')
  const data: SetupOptionsResponse = await res.json()
  return data.options ?? []
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useSetupOptions() {
  return useQuery({
    queryKey: queryKeys.setupOptions,
    queryFn: fetchSetupOptions,
  })
}

export type UseSetupOptionsReturn = ReturnType<typeof useSetupOptions>
