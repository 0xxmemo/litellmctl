import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import { extractApiKey, getSessionCookie, verifySession } from "../lib/auth";
import { validateApiKey, loadUser, trackUsage } from "../lib/db";

// LiteLLM Proxy
async function proxyHandler(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v1/, "");
  const targetUrl = `${LITELLM_URL}/v1${path}${url.search}`;

  const apiKey = extractApiKey(req);
  let email: string | null = null;
  let keyHash: string | null = null;

  if (apiKey) {
    const keyRecord = await validateApiKey(apiKey);
    if (!keyRecord) {
      return Response.json({ error: "Invalid API key" }, { status: 401 });
    }
    email = keyRecord.email;
    keyHash = keyRecord.keyHash;
  } else {
    const sessionToken = getSessionCookie(req);
    if (sessionToken) {
      const session = await verifySession(sessionToken);
      if (session) {
        const user = await loadUser(session.email);
        if (user && user.role !== "guest") {
          email = user.email;
        }
      }
    }
  }

  if (!email) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
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
          email!,
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
