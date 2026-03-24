/**
 * src/lib/models-hooks.ts — Frontend-only React hooks and browser helpers.
 *
 * Model types and utilities live in lib/models.ts (single source of truth).
 * This file adds ONLY browser-specific code: React query hooks, fetch, localStorage.
 * All data fetching uses @tanstack/react-query — no manual useState+useEffect+fetch.
 */

import { useQuery } from '@tanstack/react-query'
import type { RawModel, NormalizedModel, ExtendedModel } from '@lib/models'
import { dedupeModels, detectIsStub, resolveProviderAuth } from '@lib/models'
import { queryKeys } from '@/lib/query-keys'

// ─── Fetch helpers (browser only) ─────────────────────────────────────────────

export async function fetchModels(): Promise<NormalizedModel[]> {
  const r = await fetch('/v1/models')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data: { data: RawModel[] } = await r.json()
  return dedupeModels(data.data ?? [])
}

export async function fetchExtendedModels(): Promise<ExtendedModel[]> {
  try {
    const r = await fetch('/api/models/extended')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data: { models: ExtendedModel[] } = await r.json()
    return data.models ?? []
  } catch {
    const basic = await fetchModels()
    return basic.map((m) => ({
      ...m,
      underlyingModel: m.id,
      apiBase: null,
      litellmProvider: m.provider,
      isAlias: false,
      isStub: detectIsStub(m.id),
      ...resolveProviderAuth(m.provider),
      supportsStreaming: true,
      mode: 'chat' as const,
      maxTokens: null, maxInputTokens: null, maxOutputTokens: null,
      supportsVision: false, supportsFunctionCalling: false, supportsReasoning: false,
      supportsSystemMessages: null, supportsToolChoice: null,
      supportsPromptCaching: null, supportsResponseSchema: null,
      rpm: null, tpm: null,
    }))
  }
}

// ─── React Query hooks ────────────────────────────────────────────────────────

export function useModels() {
  const { data: models = [], isLoading: loading, error: rawError } = useQuery({
    queryKey: queryKeys.models,
    queryFn: fetchModels,
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

const LS_MODEL_PREFIX = 'llm-gateway-model:'

export function getStoredModel(endpointPath: string): string | null {
  try { return localStorage.getItem(LS_MODEL_PREFIX + endpointPath) } catch { return null }
}

export function storeModel(endpointPath: string, model: string): void {
  try { localStorage.setItem(LS_MODEL_PREFIX + endpointPath, model) } catch {}
}
