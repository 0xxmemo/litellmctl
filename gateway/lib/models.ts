/**
 * lib/models.ts — Single source of truth for model metadata.
 *
 * Pure utility functions shared between server routes and frontend components.
 * No React, no browser APIs, no side effects.
 *
 * Server imports:  import { extractProvider, buildExtendedModel } from "../lib/models"
 * Frontend imports: import { extractProvider, buildExtendedModel } from "@/lib/models"
 *                   (via tsconfig paths — @/* maps to src/*, but lib/ is at root)
 *
 * The frontend re-exports everything from src/lib/models.ts which adds React hooks,
 * fetch helpers, and localStorage utilities on top.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawModel {
  id: string
  object?: string
  owned_by: string
}

export interface NormalizedModel extends RawModel {
  displayName: string
  provider: string
}

export interface ExtendedModel extends NormalizedModel {
  underlyingModel: string
  apiBase: string | null
  litellmProvider: string
  isAlias: boolean
  isStub: boolean
  requiresApiKey: boolean
  apiKeyEnvVar: string | null
  apiKeyHint: string | null
  supportsStreaming: boolean
  /** Embedding vector width from config model_info.output_vector_size when set */
  outputVectorSize: number | null
  /**
   * Typical widths you can pass as `dimensions` on POST /v1/embeddings when supported.
   * From model_info.embedding_dimensions_options in config, or inferred for known models.
   */
  embeddingDimensionsOptions: number[] | null
  mode: 'chat' | 'embedding' | 'audio_transcription' | 'image_generation' | 'responses' | string
  maxTokens: number | null
  maxInputTokens: number | null
  maxOutputTokens: number | null
  supportsVision: boolean
  supportsFunctionCalling: boolean
  supportsReasoning: boolean
  supportsSystemMessages: boolean | null
  supportsToolChoice: boolean | null
  supportsPromptCaching: boolean | null
  supportsResponseSchema: boolean | null
  rpm: number | null
  tpm: number | null
}

// ─── Provider auth mapping ────────────────────────────────────────────────────

const PROVIDER_AUTH: Record<string, { envVar: string; hint: string } | null> = {
  local: null,
  ollama: null,
  anthropic: { envVar: 'ANTHROPIC_API_KEY', hint: 'sk-ant-...' },
  openai: { envVar: 'OPENAI_API_KEY', hint: 'sk-...' },
  chatgpt: { envVar: 'OPENAI_API_KEY', hint: 'sk-...' },
  codex: { envVar: 'OPENAI_API_KEY', hint: 'sk-...' },
  google: { envVar: 'GEMINI_API_KEY', hint: 'AIza...' },
  'gemini-cli': { envVar: 'GEMINI_API_KEY', hint: 'AIza...' },
  gemini: { envVar: 'GEMINI_API_KEY', hint: 'AIza...' },
  'qwen-cli': { envVar: 'QWEN_API_KEY', hint: 'sk-...' },
  alibaba: { envVar: 'DASHSCOPE_API_KEY', hint: 'sk-...' },
  zai: { envVar: 'ZAI_API_KEY', hint: 'sk-...' },
  minimax: { envVar: 'MINIMAX_API_KEY', hint: 'sk-...' },
  'kimi-code': { envVar: 'MOONSHOT_API_KEY', hint: 'sk-...' },
  kimi: { envVar: 'MOONSHOT_API_KEY', hint: 'sk-...' },
  mistral: { envVar: 'MISTRAL_API_KEY', hint: 'sk-...' },
  meta: { envVar: 'META_API_KEY', hint: 'sk-...' },
  'meta-llama': { envVar: 'META_API_KEY', hint: 'sk-...' },
  groq: { envVar: 'GROQ_API_KEY', hint: 'gsk_...' },
  cohere: { envVar: 'COHERE_API_KEY', hint: 'co-...' },
  perplexity: { envVar: 'PERPLEXITYAI_API_KEY', hint: 'pplx-...' },
  deepseek: { envVar: 'DEEPSEEK_API_KEY', hint: 'sk-...' },
}

export function resolveProviderAuth(provider: string): {
  requiresApiKey: boolean
  apiKeyEnvVar: string | null
  apiKeyHint: string | null
} {
  if (provider === 'local' || provider === 'ollama') {
    return { requiresApiKey: false, apiKeyEnvVar: null, apiKeyHint: null }
  }
  const auth = PROVIDER_AUTH[provider]
  if (auth === null) return { requiresApiKey: false, apiKeyEnvVar: null, apiKeyHint: null }
  if (auth) return { requiresApiKey: true, apiKeyEnvVar: auth.envVar, apiKeyHint: auth.hint }
  return { requiresApiKey: true, apiKeyEnvVar: null, apiKeyHint: 'sk-...' }
}

// ─── Provider helpers ─────────────────────────────────────────────────────────

export function extractProvider(modelId: string): string {
  if (modelId.includes('/')) return modelId.split('/')[0]
  return ''
}

export function resolveProvider(id: string, ownedBy: string): string {
  if (id.includes('/')) return id.split('/')[0]
  const lower = id.toLowerCase()
  if (lower.startsWith('claude')) return 'anthropic'
  if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return 'openai'
  if (lower.startsWith('gemini')) return 'google'
  if (lower.startsWith('qwen')) return 'alibaba'
  if (lower.startsWith('glm') || lower.startsWith('chatglm')) return 'zai'
  if (lower.startsWith('llama') || lower.startsWith('meta')) return 'meta'
  if (lower.startsWith('mistral') || lower.startsWith('mixtral')) return 'mistral'
  if (lower.startsWith('kimi')) return 'kimi'
  if (lower.startsWith('minimax')) return 'minimax'
  if (lower.startsWith('codex') || lower.startsWith('gpt-5')) return 'openai'
  return ownedBy || 'other'
}

const ACRONYMS: Record<string, string> = {
  openai: 'OpenAI', ai: 'AI', cli: 'CLI', llm: 'LLM',
  glm: 'GLM', api: 'API', sdk: 'SDK', xai: 'xAI', zai: 'ZAI',
}

export function formatProviderName(provider: string): string {
  if (!provider) return 'Other'
  return provider.split(/[-_]+/).map((w) => {
    const lower = w.toLowerCase()
    return ACRONYMS[lower] || lower.charAt(0).toUpperCase() + lower.slice(1)
  }).join(' ')
}

export function getProviderColor(provider: string): string {
  const PALETTE = [
    'bg-orange-500/15 text-orange-400 border-orange-500/30',
    'bg-green-500/15 text-green-400 border-green-500/30',
    'bg-blue-500/15 text-blue-400 border-blue-500/30',
    'bg-purple-500/15 text-purple-400 border-purple-500/30',
    'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
    'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    'bg-violet-500/15 text-violet-400 border-violet-500/30',
    'bg-amber-500/15 text-amber-400 border-amber-500/30',
    'bg-teal-500/15 text-teal-400 border-teal-500/30',
    'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
    'bg-pink-500/15 text-pink-400 border-pink-500/30',
    'bg-rose-500/15 text-rose-400 border-rose-500/30',
    'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    'bg-sky-500/15 text-sky-400 border-sky-500/30',
    'bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/30',
    'bg-lime-500/15 text-lime-400 border-lime-500/30',
  ]
  if (!provider) return 'bg-slate-500/15 text-slate-400 border-slate-500/30'
  let hash = 5381
  for (let i = 0; i < provider.length; i++) hash = (hash * 33) ^ provider.charCodeAt(i)
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

// ─── Display / stub helpers ───────────────────────────────────────────────────

export function getDisplayName(id: string): string {
  return id.includes('/') ? id.split('/').slice(1).join('/') : id
}

let _knownAliases: Set<string> = new Set()

export function registerAliases(aliases: string[]): void {
  _knownAliases = new Set(aliases.map(a => a.toLowerCase()))
}

export function detectIsStub(modelId: string): boolean {
  if (modelId.includes('/')) return false
  if (_knownAliases.size > 0) return _knownAliases.has(modelId.toLowerCase())
  const lower = modelId.toLowerCase()
  return /^[a-z]+$/.test(lower) && lower.length <= 12
}

// ─── Deduplication ────────────────────────────────────────────────────────────

export function dedupeModels(models: RawModel[]): NormalizedModel[] {
  const byProviderAndName = new Map<string, NormalizedModel[]>()
  for (const m of models) {
    const displayName = getDisplayName(m.id)
    const provider = resolveProvider(m.id, m.owned_by)
    const normalized: NormalizedModel = { ...m, displayName, provider }
    const key = `${provider}::${displayName}`
    if (!byProviderAndName.has(key)) byProviderAndName.set(key, [])
    byProviderAndName.get(key)!.push(normalized)
  }
  const result: NormalizedModel[] = []
  for (const [, entries] of byProviderAndName) {
    if (entries.length === 1) { result.push(entries[0]); continue }
    const sorted = [...entries].sort((a, b) =>
      (a.id.includes('/') ? 0 : 1) - (b.id.includes('/') ? 0 : 1))
    result.push(sorted[0])
  }
  return result.sort((a, b) =>
    a.displayName.localeCompare(b.displayName) || a.provider.localeCompare(b.provider))
}

// ─── Extended model builder ───────────────────────────────────────────────────

interface LiteLLMModelInfo {
  litellm_provider?: string
  mode?: string
  output_vector_size?: number
  /** Optional list of supported embedding widths for the `dimensions` request field */
  embedding_dimensions_options?: number[]
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_vision?: boolean
  supports_function_calling?: boolean
  supports_reasoning?: boolean
  supports_native_streaming?: boolean
  supports_system_messages?: boolean
  supports_tool_choice?: boolean
  supports_prompt_caching?: boolean
  supports_response_schema?: boolean
  rpm?: number
  tpm?: number
  input_cost_per_token?: number
  output_cost_per_token?: number
  input_cost_per_token_above_128k_tokens?: number
  output_cost_per_token_above_128k_tokens?: number
  input_cost_per_image?: number
  tiered_pricing?: Record<string, unknown>
}

function nullIfMissing<T>(v: T | undefined | null): T | null {
  return v != null ? v : null
}

function normalizeEmbeddingDimensionsOptions(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const nums = raw
    .map((x) => (typeof x === 'number' ? x : Number.parseInt(String(x), 10)))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (nums.length === 0) return null
  return [...new Set(nums)].sort((a, b) => a - b)
}

/** Merge config and lightweight inference (e.g. Nomic v2 MoE Matryoshka sizes). */
function resolveEmbeddingDimensionsOptions(
  underlyingModel: string,
  mode: string,
  fromInfo: number[] | null,
): number[] | null {
  if (fromInfo && fromInfo.length > 0) return fromInfo
  if (mode !== 'embedding') return null
  const u = underlyingModel.toLowerCase()
  if (u.includes('nomic-embed-text-v2') || u.includes('nomic-embed-text')) {
    return [256, 512, 768]
  }
  return null
}

export function buildExtendedModel(raw: {
  model_name: string
  litellm_params?: { model?: string; api_base?: string; api_key?: string }
  model_info?: LiteLLMModelInfo
}): ExtendedModel {
  const modelName = raw.model_name
  const lp = raw.litellm_params ?? {}
  const mi: LiteLLMModelInfo = raw.model_info ?? {}
  const provider = resolveProvider(modelName, '')
  const displayName = getDisplayName(modelName)
  const underlyingModel = lp.model ?? modelName
  const isAlias = underlyingModel !== modelName && !modelName.includes('/')
  const isStub = detectIsStub(modelName)
  const litellmProvider = mi.litellm_provider ?? provider
  const mode = mi.mode ?? 'chat'
  const embeddingDimensionsOptions = resolveEmbeddingDimensionsOptions(
    underlyingModel,
    mode,
    normalizeEmbeddingDimensionsOptions(mi.embedding_dimensions_options),
  )

  return {
    id: modelName,
    object: 'model',
    owned_by: litellmProvider,
    displayName,
    provider,
    underlyingModel,
    apiBase: lp.api_base ?? null,
    litellmProvider,
    isAlias,
    isStub,
    ...resolveProviderAuth(provider),
    supportsStreaming: mode !== 'embedding' && mi.supports_native_streaming !== false,
    outputVectorSize: nullIfMissing(mi.output_vector_size),
    embeddingDimensionsOptions,
    mode,
    maxTokens: nullIfMissing(mi.max_tokens),
    maxInputTokens: nullIfMissing(mi.max_input_tokens),
    maxOutputTokens: nullIfMissing(mi.max_output_tokens),
    supportsVision: mi.supports_vision ?? false,
    supportsFunctionCalling: mi.supports_function_calling ?? false,
    supportsReasoning: mi.supports_reasoning ?? false,
    supportsSystemMessages: nullIfMissing(mi.supports_system_messages),
    supportsToolChoice: nullIfMissing(mi.supports_tool_choice),
    supportsPromptCaching: nullIfMissing(mi.supports_prompt_caching),
    supportsResponseSchema: nullIfMissing(mi.supports_response_schema),
    rpm: nullIfMissing(mi.rpm),
    tpm: nullIfMissing(mi.tpm),
  }
}

// ─── Legacy compat ────────────────────────────────────────────────────────────

/** @deprecated Use getProviderColor(provider) directly. */
export function providerKey(provider: string): string { return provider || 'default' }

/** @deprecated Use formatProviderName(provider) directly. */
export function providerLabel(provider: string): string { return formatProviderName(provider) }

/** @deprecated Use getProviderColor(provider) directly. */
export const PROVIDER_COLORS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_target, prop: string) { return getProviderColor(prop) },
  has() { return true },
})
