import { verifySession, getSessionCookie } from "../lib/auth";
import { createHash, randomBytes } from "crypto";
import { apiKeys, loadUser } from "../lib/db";

// API Keys
async function getApiKeysHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const user = await loadUser(session.email);
  if (!user || user.role === "guest") {
    return Response.json({ error: "User access required" }, { status: 403 });
  }

  const keys = await apiKeys.find({ email: user.email }).toArray();
  return Response.json({ keys });
}

async function createApiKeyHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const user = await loadUser(session.email);
  if (!user || user.role === "guest") {
    return Response.json({ error: "User access required" }, { status: 403 });
  }

  const { name } = await req.json();
  const key = `sk_${randomBytes(16).toString("hex")}`;
  const keyHash = createHash("sha256").update(key.trim()).digest("hex");

  await apiKeys.insertOne({
    email: user.email,
    name: name || "Unnamed Key",
    key,
    keyHash,
    keyType: "sha256",
    revoked: false,
    createdAt: new Date(),
  });

  return Response.json({ success: true, key, name });
}

async function revokeApiKeyHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const user = await loadUser(session.email);
  if (!user || user.role === "guest") {
    return Response.json({ error: "User access required" }, { status: 403 });
  }

  const { keyId } = await req.json();
  await apiKeys.updateOne(
    { _id: keyId, email: user.email },
    { $set: { revoked: true, revokedAt: new Date() } },
  );

  return Response.json({ success: true });
}

export const keysRoutes = {
  "/api/keys":        { GET: getApiKeysHandler, POST: createApiKeyHandler },
  "/api/keys/revoke": { POST: revokeApiKeyHandler },
};
