import { createHash, randomBytes } from "crypto";
import {
  requireUser,
  listUserKeys,
  createApiKey,
  updateApiKeyMeta,
  revokeApiKey,
} from "../lib/db";

// GET /api/keys — requireUser (not guest)
// Supports: ?page=1&limit=20 (defaults: page=1, limit=20)
async function getApiKeysHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20")));

  const { keys, total } = listUserKeys(auth.email, { page, limit });

  return Response.json({
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      alias: k.alias,
      createdAt: new Date(k.createdAt).toISOString(),
      revoked: k.revoked,
    })),
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
}

// POST /api/keys — requireUser (not guest)
async function createApiKeyHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { name, alias } = await req.json();
  const plaintextKey = `sk-llm-${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(plaintextKey).digest("hex");

  const { id } = createApiKey({
    keyHash,
    name: name || "Unnamed Key",
    alias: alias || null,
    email: auth.email,
  });

  return Response.json({ key: plaintextKey, keyId: id, message: "API key created" });
}

// DELETE /api/keys/:id — requireUser (not guest)
async function deleteApiKeyHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop();
  if (!id) return Response.json({ error: "Key ID required" }, { status: 400 });

  const ok = revokeApiKey(id, auth.email);
  return Response.json({ message: ok ? "API key revoked" : "API key not found" });
}

// PUT /api/keys/:id — requireUser (not guest)
async function updateApiKeyHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop();
  if (!id) return Response.json({ error: "Key ID required" }, { status: 400 });

  const { name, alias } = await req.json();
  const ok = updateApiKeyMeta(id, auth.email, { name, alias });
  return Response.json({ message: ok ? "API key updated" : "API key not found" });
}

// Parameterized route handler for /api/keys/:id
export async function handleKeyById(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  // UUID format: 8-4-4-4-12 hex chars
  const match = url.pathname.match(/^\/api\/keys\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  if (!match) return null;

  if (req.method === "DELETE") return deleteApiKeyHandler(req);
  if (req.method === "PUT") return updateApiKeyHandler(req);
  return null;
}

export const keysRoutes = {
  "/api/keys": { GET: getApiKeysHandler, POST: createApiKeyHandler },
};
