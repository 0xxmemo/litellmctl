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
 * Fire-and-forget: extract usage from a cloned non-streaming response.
 * `resolvedModel` comes from the `x-litellm-model-name` response header, set
 * by our LiteLLM fork to the post-fallback `litellm_params.model`.
 */
function trackFromJson(
  clone: Response,
  email: string,
  requestedModel: string | null,
  keyHash: string | null,
  endpoint: string,
  resolvedModel: string | null,
) {
  clone
    .json()
    .then((data) => {
      if (data === null || typeof data !== "object") return;
      const usage = data.usage;
      if (!usage) return;
      const responseModel =
        typeof data.model === "string" ? data.model : null;
      const reqModel = requestedModel ?? responseModel;
      const actualModel = resolvedModel || responseModel || reqModel || "unknown";
      trackUsage(
        email,
        actualModel,
        usage.prompt_tokens ?? usage.input_tokens ?? 0,
        usage.completion_tokens ?? usage.output_tokens ?? 0,
        keyHash,
        reqModel || undefined,
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
  resolvedModel: string | null,
) {
  clone
    .text()
    .then((text) => {
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
      const reqModel = requestedModel ?? model;
      const actualModel = resolvedModel || model || reqModel || "unknown";
      trackUsage(
        email,
        actualModel,
        usage.prompt_tokens ?? usage.input_tokens ?? 0,
        usage.completion_tokens ?? usage.output_tokens ?? 0,
        keyHash,
        reqModel || undefined,
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

    // Decide whether we need to buffer+inspect the body. Most requests don't:
    // users without per-model overrides, and audio uploads already sent as
    // multipart, can stream straight through to LiteLLM without us ever
    // touching their bytes. Fast path has no TextDecoder/JSON.parse overhead
    // and begins forwarding as the client uploads.
    const overrides = getUserModelOverrides(auth.email);
    const hasOverrides = Object.keys(overrides).length > 0;
    const reqContentType = req.headers.get("content-type") || "";
    const isAudioForm =
      endpoint === "/audio/transcriptions" || endpoint === "/audio/translations";
    const needsAudioConversion =
      isAudioForm && !reqContentType.startsWith("multipart/");
    const mustInspectBody = hasOverrides || needsAudioConversion;

    const headers = new Headers(req.headers);
    headers.set("Authorization", LITELLM_AUTH);
    headers.delete("x-api-key");

    let fetchBody: BodyInit | undefined;
    // `requestedModel` is only set on the slow path (pre-override parse). On
    // the fast path it's derived from the response by the tracker — LiteLLM's
    // `_override_openai_response_model` forces `response.model` back to the
    // client-requested value, so either source yields the same telemetry.
    let requestedModel: string | null = null;

    if (!mustInspectBody) {
      fetchBody = req.body ?? undefined;
    } else {
      const rawBody = await req.arrayBuffer();
      let forwardForm: FormData | null = null;
      let mutatedBody: ArrayBuffer | null = null;
      try {
        const text = new TextDecoder().decode(rawBody);
        const json = JSON.parse(text);
        if (json !== null && typeof json === "object" && !Array.isArray(json)) {
          requestedModel = typeof json.model === "string" ? json.model : null;

          if (requestedModel && overrides[requestedModel]) {
            json.model = overrides[requestedModel];
            mutatedBody = new TextEncoder().encode(JSON.stringify(json)).buffer;
          }

          if (needsAudioConversion && typeof json.file === "string") {
            forwardForm = jsonAudioToFormData(json as Record<string, unknown>);
          }
        }
      } catch {
        // Not JSON — already-multipart audio or other binary uploads that
        // happened to land here. Forward the raw bytes unchanged.
      }

      if (forwardForm) {
        headers.delete("content-type");
        headers.delete("content-length");
        fetchBody = forwardForm;
      } else {
        fetchBody =
          mutatedBody ?? (rawBody.byteLength > 0 ? rawBody : undefined);
      }
    }

    const proxyRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: fetchBody,
      // Required by the fetch spec when body is a streaming ReadableStream.
      ...(fetchBody instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);

    // Usage tracking via Response.clone() — Bun streams the original to the
    // client through its native pipeline; the clone is consumed in background.
    if (proxyRes.ok) {
      const resolvedModel = proxyRes.headers.get("x-litellm-model-name");
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
          resolvedModel,
        );
      } else {
        trackFromJson(
          clone,
          auth.email,
          requestedModel,
          keyHash,
          endpoint,
          resolvedModel,
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
