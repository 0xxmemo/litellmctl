import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import { requireAuth, requireUser } from "../lib/db";
import { buildExtendedModel } from "../src/lib/models";

// GET /api/models — requireUser (not guest)
async function getModelsHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const res = await fetch(`${LITELLM_URL}/model/info`, {
    headers: { Authorization: LITELLM_AUTH },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    return Response.json(
      { error: "Failed to fetch models" },
      { status: res.status },
    );
  }

  const data = await res.json();
  return Response.json({
    models: data.data || [],
    count: data.data?.length || 0,
  });
}

// GET /api/models/extended — requireUser (not guest)
async function getExtendedModelsHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const res = await fetch(`${LITELLM_URL}/model/info`, {
      headers: { Authorization: LITELLM_AUTH },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return Response.json({ models: [], error: `LiteLLM returned ${res.status}` }, { status: 502 });
    const data = await res.json();
    const seen = new Set<string>();
    const unique = (data.data || []).filter((entry: any) => {
      const name = entry.model_name;
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
    const models = unique.map(buildExtendedModel);
    return Response.json({ models, count: models.length });
  } catch (err) {
    console.error("GET /api/models/extended error:", (err as Error).message);
    return Response.json({ models: [], error: "LiteLLM model info unavailable" }, { status: 502 });
  }
}

// GET /v1/models — public (no auth). Stream-through proxy, no buffering.
async function publicModelsHandler(_req: Request) {
  try {
    const res = await fetch(`${LITELLM_URL}/v1/models`, {
      headers: { Authorization: LITELLM_AUTH },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return Response.json({ error: "Failed to fetch models" }, { status: 502 });
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (err) {
    console.error("Proxy error /v1/models:", (err as Error).message);
    return Response.json({ error: "Failed to fetch models" }, { status: 502 });
  }
}

// GET /v1/model/info — requireAuth. Stream-through proxy, no buffering.
async function proxyModelInfoHandler(req: Request) {
  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const res = await fetch(`${LITELLM_URL}/model/info`, {
      headers: { Authorization: LITELLM_AUTH },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return Response.json({ error: "Failed to fetch model info" }, { status: 502 });
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (err) {
    return Response.json({ error: "Failed to fetch model info" }, { status: 502 });
  }
}

export const modelsRoutes = {
  "/api/models":          { GET: getModelsHandler },
  "/api/models/extended": { GET: getExtendedModelsHandler },
  "/v1/models":           { GET: publicModelsHandler },
  "/v1/model/info":       { GET: proxyModelInfoHandler },
};
