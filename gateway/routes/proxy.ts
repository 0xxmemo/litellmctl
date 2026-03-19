import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import { extractApiKey } from "../lib/auth";
import { validateApiKey, requireUser, trackUsage } from "../lib/db";

// LiteLLM Proxy — requireUser (not guest), with key hash tracking for usage
async function proxyHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v1/, "");
  const targetUrl = `${LITELLM_URL}/v1${path}${url.search}`;

  // Resolve keyHash for usage tracking (if authenticated via API key)
  let keyHash: string | null = null;
  const apiKey = extractApiKey(req);
  if (apiKey) {
    const keyRecord = await validateApiKey(apiKey);
    if (keyRecord) keyHash = keyRecord.keyHash;
  }

  // Read body for usage tracking
  const body = await req.text();
  let bodyObj: any = {};
  try {
    bodyObj = JSON.parse(body);
  } catch {}

  const model = bodyObj.model || "unknown";

  // Forward request
  const headers = new Headers(req.headers);
  headers.set("Authorization", LITELLM_AUTH);
  headers.delete("x-api-key");

  const proxyRes = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: body || undefined,
  });

  // Track usage for non-streaming responses
  if (proxyRes.ok && !bodyObj.stream) {
    try {
      const resClone = proxyRes.clone();
      const data = await resClone.json();
      const usage = data.usage;
      if (usage) {
        trackUsage(
          auth.email,
          model,
          usage.prompt_tokens || 0,
          usage.completion_tokens || 0,
          keyHash,
        );
      }
    } catch {}
  }

  return proxyRes;
}

export const proxyRoutes = {
  "/v1/chat/completions":     { POST: proxyHandler },
  "/v1/embeddings":           { POST: proxyHandler },
  "/v1/completions":          { POST: proxyHandler },
  "/v1/audio/transcriptions": { POST: proxyHandler },
};
