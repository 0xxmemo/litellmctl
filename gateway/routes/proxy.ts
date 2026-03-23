import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import { extractApiKey } from "../lib/auth";
import {
  validateApiKey,
  requireUser,
  trackUsage,
  validatedUsers,
} from "../lib/db";

/**
 * In-memory cache for user model overrides.
 * Key: email, Value: { overrides, timestamp }
 * TTL: 5 minutes
 */
const modelOverridesCache = new Map<
  string,
  { overrides: Record<string, string>; timestamp: number }
>();
const OVERRIDE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get user model overrides with caching.
 */
async function getUserModelOverrides(
  email: string,
): Promise<Record<string, string>> {
  const cached = modelOverridesCache.get(email);
  if (cached && Date.now() - cached.timestamp < OVERRIDE_CACHE_TTL) {
    return cached.overrides;
  }

  const userRecord = await validatedUsers.findOne(
    { email },
    { projection: { model_overrides: 1 } },
  );
  const overrides = userRecord?.model_overrides || {};
  modelOverridesCache.set(email, { overrides, timestamp: Date.now() });
  return overrides;
}

/**
 * Invalidate cached model overrides for a user.
 * Called when user updates their overrides via the API.
 */
export function invalidateModelOverridesCache(email: string): void {
  modelOverridesCache.delete(email);
}

/**
 * Resolve x-litellm-model-id to the actual underlying model by querying
 * LiteLLM /model/info. Runs in the background tracking path only.
 */
async function resolveModelById(modelId: string): Promise<string | null> {
  try {
    const res = await fetch(`${LITELLM_URL}/model/info`, {
      headers: { Authorization: LITELLM_AUTH },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    for (const m of data.data || []) {
      if (m.model_info?.id === modelId) {
        return m.litellm_params?.model || m.model_name || null;
      }
    }
  } catch {}
  return null;
}

/**
 * Fire-and-forget: extract usage from a cloned non-streaming response.
 */
function trackFromJson(
  clone: Response,
  email: string,
  requestedModel: string | null,
  keyHash: string | null,
  endpoint: string,
  litellmModelId: string | null,
) {
  clone
    .json()
    .then(async (data) => {
      const usage = data.usage;
      if (!usage) return;
      let actualModel = data.model || requestedModel || "unknown";
      if (litellmModelId) {
        const resolved = await resolveModelById(litellmModelId);
        if (resolved) actualModel = resolved;
      }
      trackUsage(
        email,
        actualModel,
        usage.prompt_tokens ?? usage.input_tokens ?? 0,
        usage.completion_tokens ?? usage.output_tokens ?? 0,
        keyHash,
        requestedModel || undefined,
        endpoint,
      );
    })
    .catch(() => {});
}

/**
 * Fire-and-forget: extract usage from the final SSE events of a cloned
 * streaming response.
 */
function trackFromSSE(
  clone: Response,
  email: string,
  requestedModel: string | null,
  keyHash: string | null,
  endpoint: string,
  litellmModelId: string | null,
) {
  clone
    .text()
    .then(async (text) => {
      let usage: any = null;
      let model: string | null = null;
      // Scan backwards — usage is in one of the last events
      for (const line of text.split("\n").reverse()) {
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.usage) {
            usage = evt.usage;
            model = model || evt.model;
            break;
          }
          if (evt.type === "message_delta" && evt.usage) {
            usage = evt.usage;
            break;
          }
          if (evt.type === "message_start" && evt.message) {
            model = evt.message.model;
          }
        } catch {}
      }
      if (!usage) return;
      let actualModel = model || requestedModel || "unknown";
      if (litellmModelId) {
        const resolved = await resolveModelById(litellmModelId);
        if (resolved) actualModel = resolved;
      }
      trackUsage(
        email,
        actualModel,
        usage.prompt_tokens ?? usage.input_tokens ?? 0,
        usage.completion_tokens ?? usage.output_tokens ?? 0,
        keyHash,
        requestedModel || undefined,
        endpoint,
      );
    })
    .catch(() => {});
}

// LiteLLM Proxy — requireUser (not guest), with fire-and-forget usage tracking
async function proxyHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  // Strip /v1 prefix (handle both /v1/... and /v1/v1/... gracefully)
  let endpoint = url.pathname.replace(/^\/v1/, "");
  // Handle double /v1/v1 prefix if client sends redundant /v1
  if (endpoint.startsWith("/v1")) {
    endpoint = endpoint.replace(/^\/v1/, "");
  }
  // Ensure endpoint starts with /
  if (!endpoint.startsWith("/")) {
    endpoint = "/" + endpoint;
  }
  const targetUrl = `${LITELLM_URL}/v1${endpoint}${url.search}`;

  // Resolve keyHash for usage tracking (if authenticated via API key)
  let keyHash: string | null = null;
  const apiKey = extractApiKey(req);
  if (apiKey) {
    const keyRecord = await validateApiKey(apiKey);
    if (keyRecord) keyHash = keyRecord.keyHash;
  }

  // Read body once to extract requested model and apply overrides
  let body: ArrayBuffer = await req.arrayBuffer();
  let requestedModel: string | null = null;
  try {
    const text = new TextDecoder().decode(body);
    const json = JSON.parse(text);
    requestedModel = json.model || null;

    if (requestedModel) {
      const overrides = await getUserModelOverrides(auth.email);
      if (overrides[requestedModel]) {
        json.model = overrides[requestedModel];
        body = new TextEncoder().encode(JSON.stringify(json)).buffer;
      }
    }
  } catch {}

  // Forward to LiteLLM — let Bun handle the proxy pipeline natively
  const headers = new Headers(req.headers);
  headers.set("Authorization", LITELLM_AUTH);
  headers.delete("x-api-key");

  const proxyRes = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: body.byteLength > 0 ? body : undefined,
  });

  // Usage tracking via Response.clone() — Bun streams the original to the
  // client through its native pipeline; the clone is consumed in background.
  if (proxyRes.ok) {
    const litellmModelId = proxyRes.headers.get("x-litellm-model-id");
    const contentType = proxyRes.headers.get("content-type") || "";
    const isSSE = contentType.includes("text/event-stream");
    const clone = proxyRes.clone();

    if (isSSE) {
      trackFromSSE(
        clone,
        auth.email,
        requestedModel,
        keyHash,
        endpoint,
        litellmModelId,
      );
    } else {
      trackFromJson(
        clone,
        auth.email,
        requestedModel,
        keyHash,
        endpoint,
        litellmModelId,
      );
    }
  }

  return proxyRes;
}

export const proxyRoutes = {
  "/v1/chat/completions": { POST: proxyHandler },
  "/v1/messages": { POST: proxyHandler },
  "/v1/responses": { POST: proxyHandler },
  "/v1/embeddings": { POST: proxyHandler },
  "/v1/completions": { POST: proxyHandler },
  "/v1/images/generations": { POST: proxyHandler },
  "/v1/audio/speech": { POST: proxyHandler },
  "/v1/audio/transcriptions": { POST: proxyHandler },
  "/v1/*": { POST: proxyHandler, GET: proxyHandler },
};
