import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import { errorMessage } from "../lib/errors";
import { extractApiKey } from "../lib/auth";
import {
  validateApiKey,
  requireUser,
  trackUsage,
  getUserModelOverrides as dbGetUserModelOverrides,
} from "../lib/db";

/**
 * Accept JSON `{file: "data:audio/mp3;base64,..." | "<base64>", model, ...}`
 * and convert to a multipart FormData that LiteLLM's /v1/audio/* endpoints
 * expect (they use FastAPI's `UploadFile = File(...)`). Returns null if the
 * body doesn't carry a usable `file` string — caller should then pass the
 * original bytes through untouched (multipart upload path).
 */
function jsonAudioToFormData(json: Record<string, unknown>): FormData | null {
  const fileRaw = json.file;
  if (typeof fileRaw !== "string" || fileRaw.length === 0) return null;

  let b64 = fileRaw;
  let mime = "audio/mpeg";
  let filename = "audio.mp3";
  const dataUrlMatch = fileRaw.match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/);
  if (dataUrlMatch) {
    mime = dataUrlMatch[1];
    b64 = dataUrlMatch[2];
    const ext = (mime.split("/")[1] || "mp3").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "mp3";
    filename = `audio.${ext}`;
  }

  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }

  const form = new FormData();
  form.append("file", new Blob([bytes as unknown as BlobPart], { type: mime }), filename);
  for (const [k, v] of Object.entries(json)) {
    if (k === "file" || v === null || v === undefined) continue;
    form.append(k, typeof v === "string" ? v : String(v));
  }
  return form;
}

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
function getUserModelOverrides(email: string): Record<string, string> {
  const cached = modelOverridesCache.get(email);
  if (cached && Date.now() - cached.timestamp < OVERRIDE_CACHE_TTL) {
    return cached.overrides;
  }

  const overrides = dbGetUserModelOverrides(email);
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
      if (data === null || typeof data !== "object") return;
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
          if (evt == null || typeof evt !== "object") continue;
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
  try {
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
      const keyRecord = validateApiKey(apiKey);
      if (keyRecord) keyHash = keyRecord.keyHash;
    }

    // Read body once to extract requested model and apply overrides
    let body: ArrayBuffer = await req.arrayBuffer();
    let requestedModel: string | null = null;
    let forwardForm: FormData | null = null;
    const audioFormEndpoint =
      endpoint === "/audio/transcriptions" || endpoint === "/audio/translations";
    try {
      const text = new TextDecoder().decode(body);
      const json = JSON.parse(text);
      if (json !== null && typeof json === "object" && !Array.isArray(json)) {
        requestedModel = typeof json.model === "string" ? json.model : null;

        if (requestedModel) {
          const overrides = getUserModelOverrides(auth.email);
          if (overrides[requestedModel]) {
            json.model = overrides[requestedModel];
            body = new TextEncoder().encode(JSON.stringify(json)).buffer;
          }
        }

        // /audio/transcriptions and /audio/translations accept multipart
        // uploads only. Translate a JSON `{file: "<data-url|base64>", ...}`
        // into FormData so the UI Try tab and non-multipart clients work.
        if (audioFormEndpoint && typeof json.file === "string") {
          forwardForm = jsonAudioToFormData(json as Record<string, unknown>);
        }
      }
    } catch {
      // Not JSON — already-multipart requests land here; pass through as-is.
    }

    // Forward to LiteLLM — let Bun handle the proxy pipeline natively
    const headers = new Headers(req.headers);
    headers.set("Authorization", LITELLM_AUTH);
    headers.delete("x-api-key");
    if (forwardForm) {
      // FormData needs fetch to set the multipart boundary; nuke stale headers.
      headers.delete("content-type");
      headers.delete("content-length");
    }

    const proxyRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: forwardForm ?? (body.byteLength > 0 ? body : undefined),
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
  } catch (err) {
    console.error("[proxy]", errorMessage(err));
    return Response.json({ error: "Proxy upstream error" }, { status: 502 });
  }
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
