import {
  requireAdmin,
  listAllUsers,
  listPendingRequests,
  setUserRole,
  deleteUser,
  deleteAllGuests,
  revokeAllKeysForEmail,
  revokeAllKeys,
  userUsageTotals,
  loadUser,
  userProfileCache,
} from "../lib/db";

async function getPendingRequestsHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const requests = listPendingRequests().map((r) => ({
    email: r.email,
    createdAt: new Date(r.createdAt).toISOString(),
    status: "pending",
  }));
  return Response.json({ requests });
}

async function approveUserHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const { email } = await req.json();
  setUserRole(email, "user", true);
  return Response.json({ success: true });
}

// GET /api/admin/users (includes per-user request/token totals from usage_logs)
async function adminListUsersHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const users = listAllUsers();
  const byEmail = userUsageTotals(users.map((u) => u.email.toLowerCase()));

  return Response.json({
    users: users.map((u) => {
      const st = byEmail[u.email.toLowerCase()] ?? { requests: 0, tokens: 0 };
      return {
        email: u.email,
        role: u.role,
        createdAt: new Date(u.createdAt).toISOString(),
        approvedAt: u.approvedAt ? new Date(u.approvedAt).toISOString() : null,
        requests: st.requests,
        tokens: st.tokens,
      };
    }),
  });
}

// POST /api/admin/users — create or update user
async function adminCreateUserHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const { email, role } = await req.json();
  if (!email || !email.includes("@")) {
    return Response.json({ error: "Valid email required" }, { status: 400 });
  }
  const validRoles = ["guest", "user", "admin"];
  if (!validRoles.includes(role)) {
    return Response.json({ error: "Invalid role" }, { status: 400 });
  }
  setUserRole(email, role);
  return Response.json({ success: true });
}

// DELETE /api/admin/users/:email
async function adminDeleteUserHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const email = decodeURIComponent(url.pathname.split("/api/admin/users/")[1] || "");
  if (!email) return Response.json({ error: "Email required" }, { status: 400 });
  if (email === auth.email) {
    return Response.json({ error: "Cannot delete your own account" }, { status: 400 });
  }
  deleteUser(email);
  revokeAllKeysForEmail(email);
  return Response.json({ success: true });
}

// POST /api/admin/reject — remove a pending (guest) user
async function adminRejectUserHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const { email } = await req.json();
  if (!email || typeof email !== "string") {
    return Response.json({ error: "Email required" }, { status: 400 });
  }
  const normalized = email.toLowerCase();
  if (normalized === auth.email) {
    return Response.json({ error: "Cannot reject your own account" }, { status: 400 });
  }
  const existing = loadUser(normalized);
  if (!existing) return Response.json({ error: "User not found" }, { status: 404 });
  if (existing.role !== "guest") {
    return Response.json(
      { error: "Only pending access requests (guests) can be rejected" },
      { status: 400 },
    );
  }
  deleteUser(normalized);
  revokeAllKeysForEmail(normalized);
  return Response.json({ success: true });
}

// POST /api/admin/disapprove-all
async function adminDisapproveAllHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const count = deleteAllGuests();
  userProfileCache.clear();
  return Response.json({ success: true, count });
}

// POST /api/admin/keys/revoke-all
async function adminRevokeAllKeysHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const count = revokeAllKeys();
  return Response.json({ success: true, count });
}

export const adminRoutes = {
  "/api/admin/pending":              { GET: getPendingRequestsHandler },
  "/api/admin/approve":              { POST: approveUserHandler },
  "/api/admin/users":                { GET: adminListUsersHandler, POST: adminCreateUserHandler },
  "/api/admin/users/*":              { DELETE: adminDeleteUserHandler },
  "/api/admin/reject":               { POST: adminRejectUserHandler },
  "/api/admin/disapprove-all":       { POST: adminDisapproveAllHandler },
  "/api/admin/keys/revoke-all":      { POST: adminRevokeAllKeysHandler },
};
