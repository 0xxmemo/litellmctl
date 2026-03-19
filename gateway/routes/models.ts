import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import { getAuthenticatedUser } from "../lib/db";

// Models — requireUserOrAdmin (matches reference)
async function getModelsHandler(req: Request) {
  const user = await getAuthenticatedUser(req);
  if (!user || user.role === "guest") {
    return Response.json({ error: "User access required" }, { status: 403 });
  }

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

// GET /api/models/extended — full model metadata including auth, capabilities, pricing
// Requires user or admin (not guest)
async function getExtendedModelsHandler(req: Request) {
  const user = await getAuthenticatedUser(req);
  if (!user || user.role === "guest") {
    return Response.json({ error: "User access required" }, { status: 403 });
  }

  try {
    const res = await fetch(`${LITELLM_URL}/model/info`, {
      headers: { Authorization: LITELLM_AUTH },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return Response.json({ models: [], error: `LiteLLM returned ${res.status}` }, { status: 502 });
    const data = await res.json();
    const seen = new Set<string>();
    const models = (data.data || []).filter((entry: any) => {
      const name = entry.model_name;
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
    return Response.json({ models, count: models.length });
  } catch (err) {
    console.error("GET /api/models/extended error:", (err as Error).message);
    return Response.json({ models: [], error: "LiteLLM model info unavailable" }, { status: 502 });
  }
}

// GET /v1/models — public, no auth required (clients need to discover models)
async function publicModelsHandler(_req: Request) {
  try {
    const res = await fetch(`${LITELLM_URL}/v1/models`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return Response.json({ error: "Failed to fetch models" }, { status: 502 });
    const data = await res.json();
    return Response.json(data);
  } catch (err) {
    console.error("Proxy error /v1/models:", (err as Error).message);
    return Response.json({ error: "Failed to fetch models" }, { status: 502 });
  }
}

async function proxyModelInfoHandler(_req: Request) {
  const res = await fetch(`${LITELLM_URL}/model/info`, {
    headers: { Authorization: LITELLM_AUTH },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return Response.json({ error: "Failed to fetch model info" }, { status: 502 });
  return res;
}

export const modelsRoutes = {
  "/api/models":          { GET: getModelsHandler },
  "/api/models/extended": { GET: getExtendedModelsHandler },
  "/v1/models":           { GET: publicModelsHandler },
  "/v1/model/info":       { GET: proxyModelInfoHandler },
};
