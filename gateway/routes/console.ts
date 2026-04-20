import { requireAdmin } from "../lib/db";
import { consoleEnabled, type ConsoleSocketData } from "../lib/pty";
import type { Server } from "bun";

/**
 * GET /api/admin/console — upgrades to a WebSocket carrying a PTY session.
 *
 * The actual WebSocket lifecycle lives in `Bun.serve({ websocket })` in
 * index.ts — this handler only authenticates the caller and hands the
 * connection off via `server.upgrade`.
 */
async function consoleUpgradeHandler(
  req: Request,
  server: Server<ConsoleSocketData>,
): Promise<Response> {
  if (!consoleEnabled()) {
    return Response.json({ error: "Console disabled" }, { status: 404 });
  }
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const ok = server.upgrade(req, { data: { email: auth.email } });
  if (ok) {
    // Bun takes ownership — the 101 response is synthesized internally.
    return new Response(null, { status: 101 });
  }
  return Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
}

export const consoleRoutes = {
  "/api/admin/console": {
    GET: (req: Request, server: Server<ConsoleSocketData>) =>
      consoleUpgradeHandler(req, server),
  },
};
