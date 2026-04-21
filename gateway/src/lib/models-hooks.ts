/**
 * src/lib/models-hooks.ts — Frontend-only React hooks and browser helpers.
 *
 * Model types and utilities live in lib/models.ts (single source of truth).
 * This file adds ONLY browser-specific code: React query hooks, fetch, localStorage.
 * All data fetching uses @tanstack/react-query — no manual useState+useEffect+fetch.
 */

import { useQuery } from '@tanstack/react-query'
import type { NormalizedModel, ExtendedModel } from '@lib/models'
import { queryKeys } from '@/lib/query-keys'

// ─── Fetch helpers (browser only) ─────────────────────────────────────────────

export async function fetchExtendedModels(): Promise<ExtendedModel[]> {
  const r = await fetch('/api/models/extended')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data: { models: ExtendedModel[] } = await r.json()
  return data.models ?? []
}

export function toNormalizedModels(models: ExtendedModel[]): NormalizedModel[] {
  return models.map(({ id, object, owned_by, displayName, provider }) => ({
    id,
    object,
    owned_by,
    displayName,
    provider,
  }))
}

export async function fetchModels(): Promise<NormalizedModel[]> {
  return toNormalizedModels(await fetchExtendedModels())
}

// ─── React Query hooks ────────────────────────────────────────────────────────

export function useModels() {
  const { data: models = [], isLoading: loading, error: rawError } = useQuery({
    queryKey: queryKeys.modelsExtended,
    queryFn: fetchExtendedModels,
    select: toNormalizedModels,
  })
  return { models, loading, error: rawError?.message ?? null }
}

export function useExtendedModels() {
  const { data: models = [], isLoading: loading, error: rawError } = useQuery({
    queryKey: queryKeys.modelsExtended,
    queryFn: fetchExtendedModels,
  })
  return { models, loading, error: rawError?.message ?? null }
}

export type UseModelsReturn = ReturnType<typeof useModels>
export type UseExtendedModelsReturn = ReturnType<typeof useExtendedModels>

// ─── LocalStorage helpers ─────────────────────────────────────────────────────

const LS_MODEL_PREFIX = 'litellmctl-model:'
const LS_MODEL_PREFIX_LEGACY = 'llm-gateway-model:'

export function getStoredModel(endpointPath: string): string | null {
  try {
    const k = LS_MODEL_PREFIX + endpointPath
    let v = localStorage.getItem(k)
    if (!v) {
      v = localStorage.getItem(LS_MODEL_PREFIX_LEGACY + endpointPath)
      if (v) {
        localStorage.setItem(k, v)
        localStorage.removeItem(LS_MODEL_PREFIX_LEGACY + endpointPath)
      }
    }
    return v
  } catch {
    return null
  }
}

export function storeModel(endpointPath: string, model: string): void {
  try {
    localStorage.setItem(LS_MODEL_PREFIX + endpointPath, model)
    localStorage.removeItem(LS_MODEL_PREFIX_LEGACY + endpointPath)
  } catch {
    /* ignore */
  }
}
