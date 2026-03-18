/**
 * src/lib/models.ts
 *
 * Centralized model management — single source of truth for all model lists.
 *
 * - Fetches from /v1/models (public) for the base list
 * - Fetches from /api/models/extended (authenticated) for full metadata
 * - Deduplicates intelligently (prefers provider-prefixed entries, priority ordering)
 * - Exports typed interfaces, helpers, fetch functions, and React hooks
 * - Deduplication / sharing handled by React Context (AppProvider)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawModel {
  id: string
  object?: string
  owned_by: string
}

export interface NormalizedModel extends RawModel {
  /** Clean display name — no provider prefix (e.g. "claude-opus-4-5") */
  displayName: string
  /** Resolved provider slug (e.g. "anthropic") */
  provider: string
}

/**
 * Extended model with full metadata for auth, routing, capabilities, and pricing.
 * Returned by /api/models/extended — the single source of truth for everything
 * needed to make successful API calls.
 */
export interface ExtendedModel extends NormalizedModel {
  // ── Auth / Routing ─────────────────────────────────────────────────────────
  /** LiteLLM's underlying model string (e.g. "anthropic/claude-sonnet-4-6") */
  underlyingModel: string
  /** Custom API base URL if needed (e.g. "https://api.z.ai/api/anthropic") */
  apiBase: string | null
  /** LiteLLM provider string (e.g. "anthropic", "chatgpt", "ollama") */
  litellmProvider: string
  /** Whether this is a gateway alias (e.g. "sonnet" → actual model) */
  isAlias: boolean
  /**
   * Whether this is a stub/alias entry with no provider prefix.
   * Stubs are LiteLLM model_group_alias entries (e.g. "opus", "sonnet", "haiku").
   * They have no "/" in their id and are short alias names, not real model IDs.
   */
  isStub: boolean
  /** Whether the model requires an API key to use */
  requiresApiKey: boolean
  /** Which env var holds the API key for this provider */
  apiKeyEnvVar: string | null
  /** Hint for UI: example key format (e.g. "sk-...") */
  apiKeyHint: string | null
  /** Whether streaming is supported */
  supportsStreaming: boolean

  // ── Capabilities ──────────────────────────────────────────────────────────
  /** Interaction mode */
  mode: 'chat' | 'embedding' | 'audio_transcription' | 'image_generation' | 'responses' | string
  /** Max output tokens */
  maxTokens: number | null
  /** Max input context window */
  maxInputTokens: number | null
  /** Max output tokens (alias of maxTokens for clarity) */
  maxOutputTokens: number | null
  /** Whether vision/image input is supported */
  supportsVision: boolean
  /** Whether function/tool calling is supported */
  supportsFunctionCalling: boolean
  /** Whether reasoning/thinking is supported */
  supportsReasoning: boolean
  /** Whether system messages are supported */
  supportsSystemMessages: boolean | null
  /** Whether tool_choice param is supported */
  supportsToolChoice: boolean | null
  /** Whether prompt caching is supported */
  supportsPromptCaching: boolean | null
  /** Whether structured JSON / response_schema is supported */
  supportsResponseSchema: boolean | null

  // ── Rate Limits ────────────────────────────────────────────────────────────
  /** Requests per minute limit (null if unknown/unlimited) */
  rpm: number | null
  /** Tokens per minute limit (null if unknown/unlimited) */
  tpm: number | null

  // ── Pricing ───────────────────────────────────────────────────────────────
  /** USD per input token (null if unknown/free) */
  inputCostPerToken: number | null
  /** USD per output token (null if unknown/free) */
  outputCostPerToken: number | null
  /** USD per input token above 128k context */
  inputCostPerTokenAbove128kTokens: number | null
  /** USD per output token above 128k context */
  outputCostPerTokenAbove128kTokens: number | null
  /** USD per input image */
  inputCostPerImage: number | null
  /** Tiered pricing object (provider-specific structure) */
  tieredPricing: Record<string, unknown> | null
}

// ─── Provider → API key env var mapping ──────────────────────────────────────

/**
 * Maps a provider slug (from model ID prefix or litellm_provider) to:
 * - envVar: the environment variable name for the API key
 * - hint: example key format for UI display
 *
 * This is the ONLY place where provider → auth info is defined.
 * All consumers should derive from here.
 */
const PROVIDER_AUTH: Record<string, { envVar: string; hint: string } | null> = {
  // ── No API key needed (local/free) ──
  local: null,
  ollama: null,

  // ── Standard API key providers ──
  anthropic: { envVar: 'ANTHROPIC_API_KEY', hint: 'sk-ant-...' },
  openai: { envVar: 'OPENAI_API_KEY', hint: 'sk-...' },
  chatgpt: { envVar: 'OPENAI_API_KEY', hint: 'sk-...' },
  codex: { envVar: 'OPENAI_API_KEY', hint: 'sk-...' },
  google: { envVar: 'GEMINI_API_KEY', hint: 'AIza...' },
  'gemini-cli': { envVar: 'GEMINI_API_KEY', hint: 'AIza...' },
  gemini: { envVar: 'GEMINI_API_KEY', hint: 'AIza...' },
  'qwen-cli': { envVar: 'QWEN_API_KEY', hint: 'sk-...' },
  alibaba: { envVar: 'ALIBABACLOUD_API_KEY', hint: 'sk-...' },
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

/**
 * Resolves auth info for a provider slug.
 * Falls back to a generic gateway key hint if provider is unknown.
 */
function resolveProviderAuth(provider: string): {
  requiresApiKey: boolean
  apiKeyEnvVar: string | null
  apiKeyHint: string | null
} {
  // Local/self-hosted providers need no API key
  if (provider === 'local' || provider === 'ollama') {
    return { requiresApiKey: false, apiKeyEnvVar: null, apiKeyHint: null }
  }

  const auth = PROVIDER_AUTH[provider]
  if (auth === null) {
    return { requiresApiKey: false, apiKeyEnvVar: null, apiKeyHint: null }
  }
  if (auth) {
    return { requiresApiKey: true, apiKeyEnvVar: auth.envVar, apiKeyHint: auth.hint }
  }

  // Unknown provider — assume it requires a key via the gateway
  return { requiresApiKey: true, apiKeyEnvVar: null, apiKeyHint: 'sk-...' }
}

// ─── Deterministic Provider Extraction ───────────────────────────────────────

/**
 * Extracts provider slug from a model ID.
 * "anthropic/claude-opus-4-5" → "anthropic"
 * "qwen-cli/qwen3-coder-plus" → "qwen-cli"
 * "claude-opus-4-5" → "" (no prefix)
 */
export function extractProvider(modelId: string): string {
  if (modelId.includes('/')) return modelId.split('/')[0]
  return ''
}

/**
 * Formats a provider slug into a human-readable display name.
 * Uses title-case with special handling for common abbreviations/acronyms.
 * No hardcoded mappings — works for any provider automatically.
 *
 * Examples:
 *   "anthropic"  → "Anthropic"
 *   "openai"     → "OpenAI"
 *   "qwen-cli"   → "Qwen CLI"
 *   "meta-llama" → "Meta Llama"
 *   "google"     → "Google"
 *   "zai"        → "ZAI"
 */
export function formatProviderName(provider: string): string {
  if (!provider) return 'Other'

  // Well-known acronyms/special cases that should be ALL CAPS or have specific casing
  // This is NOT a provider mapping — just a word-level formatter for known abbreviations.
  const ACRONYMS: Record<string, string> = {
    openai: 'OpenAI',
    ai: 'AI',
    cli: 'CLI',
    llm: 'LLM',
    glm: 'GLM',
    api: 'API',
    sdk: 'SDK',
    xai: 'xAI',
    zai: 'ZAI',
  }

  // Split on hyphens and underscores, title-case each word
  const words = provider.split(/[-_]+/)
  const formatted = words.map((word) => {
    const lower = word.toLowerCase()
    // Check if the full word is a known abbreviation
    if (ACRONYMS[lower]) return ACRONYMS[lower]
    // Otherwise title-case: first char upper, rest lower
    return lower.charAt(0).toUpperCase() + lower.slice(1)
  })

  return formatted.join(' ')
}

/**
 * Generates a deterministic Tailwind CSS color class for any provider.
 * Uses a string hash to pick from a palette — same provider always gets same color.
 * No hardcoded color map needed; new providers get colors automatically.
 */
export function getProviderColor(provider: string): string {
  // Color palette — diverse enough for visual distinction
  const PALETTE = [
    'bg-orange-500/15 text-orange-400 border-orange-500/30',   // 0
    'bg-green-500/15 text-green-400 border-green-500/30',      // 1
    'bg-blue-500/15 text-blue-400 border-blue-500/30',         // 2
    'bg-purple-500/15 text-purple-400 border-purple-500/30',   // 3
    'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',         // 4
    'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',   // 5
    'bg-violet-500/15 text-violet-400 border-violet-500/30',   // 6
    'bg-amber-500/15 text-amber-400 border-amber-500/30',      // 7
    'bg-teal-500/15 text-teal-400 border-teal-500/30',         // 8
    'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',   // 9
    'bg-pink-500/15 text-pink-400 border-pink-500/30',         // 10
    'bg-rose-500/15 text-rose-400 border-rose-500/30',         // 11
    'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',// 12
    'bg-sky-500/15 text-sky-400 border-sky-500/30',            // 13
    'bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/30',// 14
    'bg-lime-500/15 text-lime-400 border-lime-500/30',         // 15
  ]

  if (!provider) return 'bg-slate-500/15 text-slate-400 border-slate-500/30'

  // Simple djb2-style hash over the provider string
  let hash = 5381
  for (let i = 0; i < provider.length; i++) {
    hash = (hash * 33) ^ provider.charCodeAt(i)
  }
  const index = Math.abs(hash) % PALETTE.length
  return PALETTE[index]
}

// ─── Core deduplication helpers ───────────────────────────────────────────────

/**
 * Strips provider prefix from a model id.
 * "anthropic/claude-opus-4-5" → "claude-opus-4-5"
 * "opus" → "opus" (aliases pass through)
 */
export function getDisplayName(id: string): string {
  return id.includes('/') ? id.split('/').slice(1).join('/') : id
}

/**
 * Determines if a model ID is a stub/alias entry.
 * Stubs are LiteLLM model_group_alias entries with no provider prefix —
 * short names that point to real models (e.g. "ultra", "plus", "lite").
 * Rule: no "/" in the id AND doesn't look like a real model name.
 *
 * Dynamic: checks against the runtime alias registry (populated from config).
 * Falls back to heuristic detection if the registry is empty.
 */

/** Runtime registry of known alias names — populated from /api/admin/litellm-config */
let _knownAliases: Set<string> = new Set()

/** Called by AppContext when config loads to register all model_group_alias keys */
export function registerAliases(aliases: string[]): void {
  _knownAliases = new Set(aliases.map(a => a.toLowerCase()))
}

export function detectIsStub(modelId: string): boolean {
  // Any model with a "/" is a real provider-prefixed model, never a stub
  if (modelId.includes('/')) return false

  // If we have the runtime alias registry, use it
  if (_knownAliases.size > 0) {
    return _knownAliases.has(modelId.toLowerCase())
  }

  // Fallback heuristic: stubs are short names with no dots, dashes, or version numbers
  // that don't look like real model IDs. A real model usually has either "/" (provider prefix),
  // version numbers (e.g. "gpt-4o", "claude-3"), or provider names embedded.
  const lower = modelId.toLowerCase()
  // Heuristic: no digits, no dots, short (≤12 chars) → likely an alias
  return /^[a-z]+$/.test(lower) && lower.length <= 12
}

/**
 * Resolves provider from model id prefix, name patterns, or owned_by field.
 * Deterministic: always prefers the explicit prefix when present.
 */
export function resolveProvider(id: string, ownedBy: string): string {
  // If model ID has a provider prefix, use it directly — no guessing needed
  if (id.includes('/')) return id.split('/')[0]

  // Fallback pattern matching for alias/unprefixed models
  const lower = id.toLowerCase()
  if (lower.startsWith('claude'))
    return 'anthropic'
  if (
    lower.startsWith('gpt') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4')
  )
    return 'openai'
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

/**
 * Deduplicates and normalizes raw models from /v1/models.
 *
 * Strategy:
 * 1. Group by (provider, displayName) — same provider + same model name are duplicates.
 * 2. Within each provider-group, prefer the PREFIXED id (provider/model-name).
 * 3. Different providers are NEVER merged — e.g. qwen-cli/qwen3-coder-plus and
 *    alibaba/qwen3-coder-plus are different endpoints and both must appear.
 * 4. Sort alphabetically by displayName, then provider.
 */
export function dedupeModels(models: RawModel[]): NormalizedModel[] {
  // Key: "provider::displayName" — only dedupe within the same provider
  const byProviderAndName = new Map<string, NormalizedModel[]>()

  for (const m of models) {
    const displayName = getDisplayName(m.id)
    const provider = resolveProvider(m.id, m.owned_by)
    const normalized: NormalizedModel = { ...m, displayName, provider }

    const key = `${provider}::${displayName}`
    if (!byProviderAndName.has(key)) {
      byProviderAndName.set(key, [])
    }
    byProviderAndName.get(key)!.push(normalized)
  }

  const result: NormalizedModel[] = []
  for (const [, entries] of byProviderAndName) {
    if (entries.length === 1) {
      result.push(entries[0])
      continue
    }

    // Multiple entries for the same provider+name — prefer the prefixed id
    const sorted = [...entries].sort((a, b) => {
      const aPrefixed = a.id.includes('/') ? 0 : 1
      const bPrefixed = b.id.includes('/') ? 0 : 1
      return aPrefixed - bPrefixed
    })

    result.push(sorted[0])
  }

  return result.sort((a, b) => {
    const nameCompare = a.displayName.localeCompare(b.displayName)
    if (nameCompare !== 0) return nameCompare
    return a.provider.localeCompare(b.provider)
  })
}

// ─── Extended model builder ───────────────────────────────────────────────────

/** Raw LiteLLM model_info shape — fields we care about */
interface LiteLLMModelInfo {
  litellm_provider?: string
  mode?: string
  // Limits
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  // Capabilities
  supports_vision?: boolean
  supports_function_calling?: boolean
  supports_reasoning?: boolean
  supports_native_streaming?: boolean
  supports_system_messages?: boolean
  supports_tool_choice?: boolean
  supports_prompt_caching?: boolean
  supports_response_schema?: boolean
  // Rate limits
  rpm?: number
  tpm?: number
  // Pricing
  input_cost_per_token?: number
  output_cost_per_token?: number
  input_cost_per_token_above_128k_tokens?: number
  output_cost_per_token_above_128k_tokens?: number
  input_cost_per_image?: number
  tiered_pricing?: Record<string, unknown>
}

/** Helper: returns null when value is 0 or undefined (LiteLLM uses 0 for "unknown/free") */
function nullIfZero(v: number | undefined | null): number | null {
  return v != null && v > 0 ? v : null
}

/** Helper: returns null when value is undefined */
function nullIfMissing<T>(v: T | undefined | null): T | null {
  return v != null ? v : null
}

/**
 * Builds a complete ExtendedModel from a LiteLLM /model/info entry.
 * This is the authoritative metadata builder — all auth/capability info
 * flows through here, with no scattered logic elsewhere.
 */
export function buildExtendedModel(raw: {
  model_name: string
  litellm_params?: {
    model?: string
    api_base?: string
    api_key?: string
  }
  model_info?: LiteLLMModelInfo
}): ExtendedModel {
  const modelName = raw.model_name
  const lp = raw.litellm_params ?? {}
  const mi: LiteLLMModelInfo = raw.model_info ?? {}

  // Derive provider from model_name prefix (most reliable)
  const provider = resolveProvider(modelName, '')
  const displayName = getDisplayName(modelName)

  // Underlying model (what LiteLLM actually calls)
  const underlyingModel = lp.model ?? modelName
  const isAlias = underlyingModel !== modelName && !modelName.includes('/')
  const isStub = detectIsStub(modelName)

  // API base from litellm_params (custom routing like zai, minimax)
  const apiBase = lp.api_base ?? null

  // LiteLLM provider string (from model_info, may differ from our provider prefix)
  const litellmProvider = mi.litellm_provider ?? provider

  // Auth info — derived from our provider slug
  const authInfo = resolveProviderAuth(provider)

  // Streaming: supported unless explicitly null and not a responses-mode model
  const mode = mi.mode ?? 'chat'
  const supportsStreaming = mode !== 'embedding' && mi.supports_native_streaming !== false

  return {
    // NormalizedModel fields
    id: modelName,
    object: 'model',
    owned_by: litellmProvider,
    displayName,
    provider,

    // Auth / Routing
    underlyingModel,
    apiBase,
    litellmProvider,
    isAlias,
    isStub,
    ...authInfo,
    supportsStreaming,

    // Capabilities
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

    // Rate Limits
    rpm: nullIfMissing(mi.rpm),
    tpm: nullIfMissing(mi.tpm),

    // Pricing
    inputCostPerToken: nullIfZero(mi.input_cost_per_token),
    outputCostPerToken: nullIfZero(mi.output_cost_per_token),
    inputCostPerTokenAbove128kTokens: nullIfZero(mi.input_cost_per_token_above_128k_tokens),
    outputCostPerTokenAbove128kTokens: nullIfZero(mi.output_cost_per_token_above_128k_tokens),
    inputCostPerImage: nullIfZero(mi.input_cost_per_image),
    tieredPricing: nullIfMissing(mi.tiered_pricing),
  }
}

// ─── Legacy compatibility exports ────────────────────────────────────────────
// These wrap the new deterministic functions so existing component code
// that calls providerKey/providerLabel/PROVIDER_COLORS still works without changes.

/**
 * @deprecated Use getProviderColor(provider) directly.
 * Returns the Tailwind color class for a provider slug.
 */
export function providerKey(provider: string): string {
  // Returns the provider slug itself — callers should use getProviderColor()
  return provider || 'default'
}

/**
 * @deprecated Use formatProviderName(provider) directly.
 */
export function providerLabel(provider: string): string {
  return formatProviderName(provider)
}

/**
 * @deprecated Use getProviderColor(provider) directly.
 * Kept for backward compatibility; dynamically generated now.
 */
export const PROVIDER_COLORS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_target, prop: string) {
    return getProviderColor(prop)
  },
  has(_target, _prop) {
    return true
  },
})

/**
 * Fetches and deduplicates the model list from /v1/models.
 * No module-level cache — React Context handles deduplication and sharing.
 */
export async function fetchModels(): Promise<NormalizedModel[]> {
  const r = await fetch('/v1/models')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data: { data: RawModel[] } = await r.json()
  return dedupeModels(data.data ?? [])
}

/**
 * Fetches extended model metadata from /api/models/extended.
 * Falls back to basic models if the endpoint is unavailable.
 * No module-level cache — React Context handles deduplication and sharing.
 */
export async function fetchExtendedModels(): Promise<ExtendedModel[]> {
  try {
    const r = await fetch('/api/models/extended')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data: { models: ExtendedModel[] } = await r.json()
    return data.models ?? []
  } catch {
    // Fallback: use basic models with minimal extended fields
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
      mode: 'chat',
      maxTokens: null,
      maxInputTokens: null,
      maxOutputTokens: null,
      supportsVision: false,
      supportsFunctionCalling: false,
      supportsReasoning: false,
      supportsSystemMessages: null,
      supportsToolChoice: null,
      supportsPromptCaching: null,
      supportsResponseSchema: null,
      rpm: null,
      tpm: null,
      inputCostPerToken: null,
      outputCostPerToken: null,
      inputCostPerTokenAbove128kTokens: null,
      outputCostPerTokenAbove128kTokens: null,
      inputCostPerImage: null,
      tieredPricing: null,
    }))
  }
}

// ─── React hooks ──────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react'

/**
 * Hook for basic model list. Fetches on mount.
 */
export function useModels() {
  const [models, setModels] = useState<NormalizedModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m)
        setLoading(false)
      })
      .catch((e: Error) => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  return { models, loading, error }
}

/**
 * Hook for extended model metadata — includes auth, capabilities, pricing.
 * Falls back gracefully to basic models if extended endpoint unavailable.
 */
export function useExtendedModels() {
  const [models, setModels] = useState<ExtendedModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchExtendedModels()
      .then((m) => {
        setModels(m)
        setLoading(false)
      })
      .catch((e: Error) => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  return { models, loading, error }
}

// ─── LocalStorage helpers ─────────────────────────────────────────────────────

const LS_MODEL_PREFIX = 'llm-gateway-model:'

export function getStoredModel(endpointPath: string): string | null {
  try {
    return localStorage.getItem(LS_MODEL_PREFIX + endpointPath)
  } catch {
    return null
  }
}

export function storeModel(endpointPath: string, model: string): void {
  try {
    localStorage.setItem(LS_MODEL_PREFIX + endpointPath, model)
  } catch {}
}
