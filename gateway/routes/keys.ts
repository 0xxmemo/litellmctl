import { ObjectId } from "mongodb";
import { createHash, randomBytes } from "crypto";
import { apiKeys, requireUser } from "../lib/db";

// GET /api/keys — requireUser (not guest)
// Supports: ?page=1&limit=20 (defaults: page=1, limit=20)
// Always sorted by createdAt descending (most recent first)
async function getApiKeysHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20")));
  const skip = (page - 1) * limit;

  const filter = { email: auth.email, revoked: false };
  const [keys, total] = await Promise.all([
    apiKeys.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    apiKeys.countDocuments(filter),
  ]);

  return Response.json({
    keys: keys.map((k: any) => ({
      id: k._id.toString(),
      name: k.name,
      alias: k.alias,
      createdAt: k.createdAt,
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

  const keyDoc: any = {
    keyHash,
    keyType: "sha256",
    name: name || "Unnamed Key",
    alias,
    email: auth.email,
    revoked: false,
    createdAt: new Date(),
  };

  await apiKeys.insertOne(keyDoc);
  return Response.json({ key: plaintextKey, keyId: keyDoc._id?.toString(), message: "API key created" });
}

// DELETE /api/keys/:id — requireUser (not guest)
async function deleteApiKeyHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop();
  if (!id) return Response.json({ error: "Key ID required" }, { status: 400 });

  const result = await apiKeys.updateOne(
    { _id: new ObjectId(id), email: auth.email },
    { $set: { revoked: true, revokedAt: new Date() } },
  );

  return Response.json({ message: result.matchedCount ? "API key revoked" : "API key not found" });
}

// PUT /api/keys/:id — requireUser (not guest)
async function updateApiKeyHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop();
  if (!id) return Response.json({ error: "Key ID required" }, { status: 400 });

  const { name, alias } = await req.json();
  const result = await apiKeys.updateOne(
    { _id: new ObjectId(id), email: auth.email },
    { $set: { name, alias } },
  );

  return Response.json({ message: result.matchedCount ? "API key updated" : "API key not found" });
}

// Parameterized route handler for /api/keys/:id
// Bun.serve static routes don't support :param patterns,
// so this is called from the fetch fallback in index.ts
export async function handleKeyById(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/keys\/([a-f0-9]{24})$/);
  if (!match) return null;

  if (req.method === "DELETE") return deleteApiKeyHandler(req);
  if (req.method === "PUT") return updateApiKeyHandler(req);
  return null;
}

export const keysRoutes = {
  "/api/keys": { GET: getApiKeysHandler, POST: createApiKeyHandler },
};
