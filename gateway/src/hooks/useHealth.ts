import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

export interface HealthFeatures {
  search: boolean
  embedding: boolean
  transcription: boolean
  proton: boolean
  database: boolean
  console: boolean
}

export interface HealthResponse {
  status: 'ok' | 'error'
  uptime: number
  features: HealthFeatures
}

async function fetchHealth(): Promise<HealthResponse | null> {
  const res = await fetch('/api/health', { credentials: 'include' })
  if (!res.ok) return null
  return (await res.json()) as HealthResponse
}

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: fetchHealth,
    staleTime: 60_000,
  })
}

export type UseHealthReturn = ReturnType<typeof useHealth>
