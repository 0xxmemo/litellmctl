import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import { extractApiKey } from "../lib/auth";
import { validateApiKey, requireUser, trackUsage } from "../lib/db";

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
  clone.json().then(async (data) => {
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
  }).catch(() => {});
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
  clone.text().then(async (text) => {
    let usage: any = null;
    let model: string | null = null;
    // Scan backwards — usage is in one of the last events
    for (const line of text.split("\n").reverse()) {
      if (!line.startsWith("data: ")) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.usage) { usage = evt.usage; model = model || evt.model; break; }
        if (evt.type === "message_delta" && evt.usage) { usage = evt.usage; break; }
        if (evt.type === "message_start" && evt.message) { model = evt.message.model; }
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
  }).catch(() => {});
}

// LiteLLM Proxy — requireUser (not guest), with fire-and-forget usage tracking
async function proxyHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const endpoint = url.pathname.replace(/^\/v1/, "");
  const targetUrl = `${LITELLM_URL}/v1${endpoint}${url.search}`;

  // Resolve keyHash for usage tracking (if authenticated via API key)
  let keyHash: string | null = null;
  const apiKey = extractApiKey(req);
  if (apiKey) {
    const keyRecord = await validateApiKey(apiKey);
    if (keyRecord) keyHash = keyRecord.keyHash;
  }

  // Read body once to extract requested model
  const body = await req.arrayBuffer();
  let requestedModel: string | null = null;
  try {
    requestedModel = JSON.parse(new TextDecoder().decode(body)).model || null;
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
      trackFromSSE(clone, auth.email, requestedModel, keyHash, endpoint, litellmModelId);
    } else {
      trackFromJson(clone, auth.email, requestedModel, keyHash, endpoint, litellmModelId);
    }
  }

  return proxyRes;
}

export const proxyRoutes = {
  "/v1/chat/completions":     { POST: proxyHandler },
  "/v1/messages":             { POST: proxyHandler },
  "/v1/responses":            { POST: proxyHandler },
  "/v1/embeddings":           { POST: proxyHandler },
  "/v1/completions":          { POST: proxyHandler },
  "/v1/images/generations":   { POST: proxyHandler },
  "/v1/audio/speech":         { POST: proxyHandler },
  "/v1/audio/transcriptions": { POST: proxyHandler },
};
