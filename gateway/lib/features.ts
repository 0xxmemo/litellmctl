/**
 * Centralized feature-availability checks shared by /api/health and any
 * surface that gates behavior on a feature being usable (e.g. the chat
 * completions handler hiding the server-side image tool when no image model
 * is configured).
 *
 * Probes that require an upstream call (LiteLLM /model/info) are cached
 * in-module so hot paths can await them without hammering the proxy.
 */

import { LITELLM_URL, LITELLM_AUTH } from "./config";

const IMAGE_MODELS_TTL_MS = 5 * 60 * 1000;
let imageModelsCache: { list: string[]; ts: number } | null = null;

/**
 * Names of every model LiteLLM has wired up with mode=image_generation.
 * Cached 5 min. Upstream failures return an empty list and are NOT cached,
 * so a transient outage doesn't latch the tool into the off state.
 */
export async function listImageModels(): Promise<string[]> {
  const now = Date.now();
  if (imageModelsCache && now - imageModelsCache.ts < IMAGE_MODELS_TTL_MS) {
    return imageModelsCache.list;
  }
  try {
    const res = await fetch(`${LITELLM_URL}/model/info`, {
      headers: { Authorization: LITELLM_AUTH },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    const entries: any[] = Array.isArray(data?.data) ? data.data : [];
    const seen = new Set<string>();
    const list: string[] = [];
    for (const e of entries) {
      if (e?.model_info?.mode !== "image_generation") continue;
      const name = typeof e?.model_name === "string" ? e.model_name : null;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      list.push(name);
    }
    imageModelsCache = { list, ts: now };
    return list;
  } catch {
    return [];
  }
}

/**
 * True when at least one image-generation model is wired up on the upstream
 * LiteLLM proxy. Provider-agnostic — works for Google, OpenAI, Vertex, or
 * anything else the operator has configured.
 */
export async function imageGenerationHealthy(): Promise<boolean> {
  return (await listImageModels()).length > 0;
}

/** Test hook / admin knob: forget the cached model list. */
export function invalidateImageModelsCache(): void {
  imageModelsCache = null;
}
