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
  listTeams,
  createTeam,
  deleteTeam,
  getTeam,
  listTeamMembers,
  addTeamMember,
  removeTeamMember,
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

// ── Teams ───────────────────────────────────────────────────────────────────

async function adminListTeamsHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  return Response.json({ teams: listTeams() });
}

async function adminCreateTeamHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name : "";
  if (!name.trim()) return Response.json({ error: "Team name required" }, { status: 400 });
  try {
    const team = createTeam(name, auth.email);
    return Response.json({ team }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /UNIQUE constraint/i.test(msg) ? 409 : 400;
    return Response.json({ error: msg }, { status });
  }
}

/** Extract one url path segment relative to a prefix — rejects extra slashes. */
function extractPathSegment(url: URL, prefix: string): string | null {
  if (!url.pathname.startsWith(prefix)) return null;
  const tail = url.pathname.slice(prefix.length);
  if (!tail || tail.includes("/")) return null;
  try {
    return decodeURIComponent(tail);
  } catch {
    return null;
  }
}

async function adminDeleteTeamHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const id = extractPathSegment(new URL(req.url), "/api/admin/teams/");
  if (!id) return Response.json({ error: "Team id required" }, { status: 400 });
  if (!getTeam(id)) return Response.json({ error: "Team not found" }, { status: 404 });
  deleteTeam(id);
  return Response.json({ success: true });
}

async function adminListTeamMembersHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  // path is /api/admin/teams/<id>/members
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/admin\/teams\/([^/]+)\/members$/);
  const id = match ? decodeURIComponent(match[1]) : null;
  if (!id) return Response.json({ error: "Team id required" }, { status: 400 });
  if (!getTeam(id)) return Response.json({ error: "Team not found" }, { status: 404 });
  return Response.json({ members: listTeamMembers(id) });
}

async function adminAddTeamMemberHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/admin\/teams\/([^/]+)\/members$/);
  const id = match ? decodeURIComponent(match[1]) : null;
  if (!id) return Response.json({ error: "Team id required" }, { status: 400 });
  if (!getTeam(id)) return Response.json({ error: "Team not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) {
    return Response.json({ error: "Valid email required" }, { status: 400 });
  }
  const user = loadUser(email);
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });
  if (user.role === "guest") {
    return Response.json({ error: "Cannot add a pending (guest) user" }, { status: 400 });
  }
  addTeamMember(id, email);
  return Response.json({ success: true });
}

async function adminRemoveTeamMemberHandler(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/admin\/teams\/([^/]+)\/members\/([^/]+)$/);
  if (!match) return Response.json({ error: "Team id and email required" }, { status: 400 });
  const id = decodeURIComponent(match[1]);
  const email = decodeURIComponent(match[2]).toLowerCase();
  if (!getTeam(id)) return Response.json({ error: "Team not found" }, { status: 404 });
  removeTeamMember(id, email);
  return Response.json({ success: true });
}

/**
 * Fallback dispatcher for parameterized /api/admin/teams/* paths. Returns
 * null when the path doesn't match, so the caller can fall through to other
 * handlers / 404.
 */
export async function handleAdminTeamsByPath(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/admin/teams/")) return null;

  const membersWithEmail = url.pathname.match(/^\/api\/admin\/teams\/([^/]+)\/members\/([^/]+)$/);
  if (membersWithEmail) {
    if (req.method === "DELETE") return adminRemoveTeamMemberHandler(req);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const membersList = url.pathname.match(/^\/api\/admin\/teams\/([^/]+)\/members$/);
  if (membersList) {
    if (req.method === "GET") return adminListTeamMembersHandler(req);
    if (req.method === "POST") return adminAddTeamMemberHandler(req);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const teamById = url.pathname.match(/^\/api\/admin\/teams\/([^/]+)$/);
  if (teamById) {
    if (req.method === "DELETE") return adminDeleteTeamHandler(req);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  return null;
}

export const adminRoutes = {
  "/api/admin/pending":              { GET: getPendingRequestsHandler },
  "/api/admin/approve":              { POST: approveUserHandler },
  "/api/admin/users":                { GET: adminListUsersHandler, POST: adminCreateUserHandler },
  "/api/admin/users/*":              { DELETE: adminDeleteUserHandler },
  "/api/admin/reject":               { POST: adminRejectUserHandler },
  "/api/admin/disapprove-all":       { POST: adminDisapproveAllHandler },
  "/api/admin/keys/revoke-all":      { POST: adminRevokeAllKeysHandler },
  "/api/admin/teams":                { GET: adminListTeamsHandler, POST: adminCreateTeamHandler },
};
