import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import { extractApiKey } from "../lib/auth";
import { validateApiKey, requireUser, trackUsage } from "../lib/db";

const _textDecoder = new TextDecoder();

/**
 * Resolve x-litellm-model-id to the actual underlying model by querying
 * LiteLLM /model/info. Atomic per-request — no pre-built maps.
 * Runs in the fire-and-forget tracking path so it never blocks the client.
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

  // Read body to extract requested model
  const body = await req.text();
  let requestedModel: string | null = null;
  try {
    const parsed = JSON.parse(body);
    requestedModel = parsed.model || null;
  } catch {}

  // Forward request to LiteLLM
  const headers = new Headers(req.headers);
  headers.set("Authorization", LITELLM_AUTH);
  headers.delete("x-api-key");

  const proxyRes = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: body || undefined,
  });

  // Fire-and-forget usage tracking via tee() — client gets response immediately
  if (proxyRes.body && proxyRes.ok) {
    const [trackStream, clientStream] = proxyRes.body.tee();
    // Grab the model-id header before returning (headers are available immediately)
    const litellmModelId = proxyRes.headers.get("x-litellm-model-id");

    // Background: read the tracking copy and log usage (never blocks client)
    (async () => {
      try {
        const reader = trackStream.getReader();
        const chunks: Uint8Array[] = [];
        let totalLen = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalLen += value.length;
        }
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        const data = JSON.parse(_textDecoder.decode(merged));
        const usage = data.usage;
        if (usage) {
          // Resolve the actual underlying model from x-litellm-model-id.
          // This is the deployment that actually handled the request,
          // even through fallback chains. No cached maps needed.
          let actualModel = data.model || requestedModel || "unknown";
          if (litellmModelId) {
            const resolved = await resolveModelById(litellmModelId);
            if (resolved) actualModel = resolved;
          }

          trackUsage(
            auth.email,
            actualModel,
            usage.prompt_tokens ?? usage.input_tokens ?? 0,
            usage.completion_tokens ?? usage.output_tokens ?? 0,
            keyHash,
            requestedModel || undefined,
            endpoint,
          );
        }
      } catch { /* non-fatal */ }
    })();

    return new Response(clientStream, {
      status: proxyRes.status,
      headers: proxyRes.headers,
    });
  }

  // Error or empty body — return as-is
  return proxyRes;
}

export const proxyRoutes = {
  "/v1/chat/completions":     { POST: proxyHandler },
  "/v1/embeddings":           { POST: proxyHandler },
  "/v1/completions":          { POST: proxyHandler },
  "/v1/audio/transcriptions": { POST: proxyHandler },
};
