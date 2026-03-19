import { CONFIG_PATH } from "../lib/config";
import { accessRequests, apiKeys, validatedUsers, userProfileCache, apiKeyCache, requireAdmin } from "../lib/db";

// Admin: pending requests
async function getPendingRequestsHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const requests = await accessRequests.find({ status: "pending" }).toArray();
  return Response.json({ requests });
}

// Admin: approve user
async function approveUserHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const { email } = await req.json();
  await validatedUsers.updateOne(
    { email: email.toLowerCase() },
    { $set: { role: "user", approvedAt: new Date() } },
  );

  userProfileCache.delete(email.toLowerCase());
  return Response.json({ success: true });
}

// GET /api/admin/users
async function adminListUsersHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const users = await validatedUsers.find({}).sort({ createdAt: -1 }).toArray();
  return Response.json({ users: users.map((u: any) => ({
    email: u.email, role: u.role, createdAt: u.createdAt, approvedAt: u.approvedAt,
  }))});
}

// POST /api/admin/users  — create or update user
async function adminCreateUserHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { email, role } = await req.json();
  if (!email || !email.includes("@")) return Response.json({ error: "Valid email required" }, { status: 400 });
  const validRoles = ["guest", "user", "admin"];
  if (!validRoles.includes(role)) return Response.json({ error: "Invalid role" }, { status: 400 });
  await validatedUsers.updateOne(
    { email: email.toLowerCase() },
    { $set: { email: email.toLowerCase(), role }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  userProfileCache.delete(email.toLowerCase());
  return Response.json({ success: true });
}

// DELETE /api/admin/users/:email  (Bun wildcard route handles path extraction)
async function adminDeleteUserHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const email = decodeURIComponent(url.pathname.split("/api/admin/users/")[1] || "");
  if (!email) return Response.json({ error: "Email required" }, { status: 400 });
  if (email === auth.email) return Response.json({ error: "Cannot delete your own account" }, { status: 400 });
  await Promise.all([
    validatedUsers.deleteOne({ email: email.toLowerCase() }),
    apiKeys.updateMany({ email: email.toLowerCase() }, { $set: { revoked: true, revokedAt: new Date() } }),
  ]);
  userProfileCache.delete(email.toLowerCase());
  return Response.json({ success: true });
}

// POST /api/admin/reject — reset user back to guest
async function adminRejectUserHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { email } = await req.json();
  await validatedUsers.updateOne({ email: email.toLowerCase() }, { $set: { role: "guest" } });
  userProfileCache.delete(email.toLowerCase());
  return Response.json({ success: true });
}

// POST /api/admin/disapprove-all — reset all guest users (delete them)
async function adminDisapproveAllHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const result = await validatedUsers.deleteMany({ role: "guest" });
  userProfileCache.clear();
  return Response.json({ success: true, count: result.deletedCount });
}

// POST /api/admin/keys/revoke-all — revoke all API keys
async function adminRevokeAllKeysHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const result = await apiKeys.updateMany({ revoked: false }, { $set: { revoked: true, revokedAt: new Date() } });
  apiKeyCache.clear();
  return Response.json({ success: true, count: result.modifiedCount });
}

// GET /api/admin/litellm-config — read config.yaml
async function adminGetConfigHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  try {
    const yaml = await import("js-yaml");
    const file = Bun.file(CONFIG_PATH);
    if (!(await file.exists())) return Response.json({ error: "config.yaml not found" }, { status: 404 });
    const text = await file.text();
    const parsed = yaml.load(text) as any;
    return Response.json(parsed || {});
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

// PATCH /api/admin/litellm-config — update config.yaml
async function adminUpdateConfigHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  try {
    const yaml = await import("js-yaml");
    const patch = await req.json();
    const file = Bun.file(CONFIG_PATH);
    let current: any = {};
    if (await file.exists()) {
      current = yaml.load(await file.text()) as any || {};
    }
    const merged = { ...current, ...patch };
    await Bun.write(CONFIG_PATH, yaml.dump(merged, { lineWidth: 120, quotingType: '"' }));
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST /api/admin/litellm-config/reset — re-read config from disk
async function adminResetConfigHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  return adminGetConfigHandler(req);
}

export const adminRoutes = {
  "/api/admin/pending":              { GET: getPendingRequestsHandler },
  "/api/admin/approve":              { POST: approveUserHandler },
  "/api/admin/users":                { GET: adminListUsersHandler, POST: adminCreateUserHandler },
  "/api/admin/users/*":              { DELETE: adminDeleteUserHandler },
  "/api/admin/reject":               { POST: adminRejectUserHandler },
  "/api/admin/disapprove-all":       { POST: adminDisapproveAllHandler },
  "/api/admin/keys/revoke-all":      { POST: adminRevokeAllKeysHandler },
  "/api/admin/litellm-config":       { GET: adminGetConfigHandler, PATCH: adminUpdateConfigHandler },
  "/api/admin/litellm-config/reset": { POST: adminResetConfigHandler },
};
