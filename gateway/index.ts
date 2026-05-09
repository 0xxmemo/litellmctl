/**
 * LitellmCTL - Bun Stack
 *
 * A lightweight authentication and rate-limiting proxy for LiteLLM.
 * Built with Bun.serve() for simplicity and performance.
 */

import { initConfig, PORT } from "./lib/config";
import { errorMessage } from "./lib/errors";
import {
  connectDB,
  initCliSecret,
  flushUsageQueue,
  rateLimitMap,
  otpRateLimitMap,
  OTP_RATE_LIMIT_WINDOW_MS,
  sweepExpiredOtpsAndSessions,
} from "./lib/db";
import { authRoutes } from "./routes/auth";
import { keysRoutes, handleKeyById } from "./routes/keys";
import { modelsRoutes } from "./routes/models";
import { statsRoutes } from "./routes/stats";
import { userRoutes } from "./routes/user";
import { adminRoutes, handleAdminTeamsByPath } from "./routes/admin";
import { proxyRoutes } from "./routes/proxy";
import { searchRoutes } from "./routes/search";
import { healthRoutes } from "./routes/health";
import { setupRoutes } from "./routes/setup";
import { skillsRoutes } from "./routes/skills";
import { pluginsRoutes } from "./routes/plugins";
import { consoleRoutes } from "./routes/console";
import { gatewayPlugins } from "./plugins";
import { buildPluginRoutes, runPluginMigrations } from "./lib/plugin-registry";

const pluginRegistryRoutes = buildPluginRoutes(gatewayPlugins);
import {
  attachPty,
  detachPty,
  handleClientMessage,
  type ConsoleSocketData,
} from "./lib/pty";

// Last-resort handlers — any throw that escapes a request handler, an
// interval callback, or a detached promise lands here. We log and keep the
// process alive; Bun's per-request error() still runs for handler throws.
process.on("uncaughtException", (err) => {
  console.error("[gateway][uncaughtException]", err);
});

// Sliding-window unhandled-rejection guard. A single stray rejection (e.g. an
// aborted client fetch) is fine, but a burst means the event loop is
// corrupted (Bun's `null is not an object` in the fetch controller has been
// the recurring offender) and we're better off letting the supervisor
// restart us than serving hung requests with a poisoned loop.
const REJECTION_THRESHOLD = 10;
const REJECTION_WINDOW_MS = 60_000;
const rejectionTimestamps: number[] = [];
process.on("unhandledRejection", (reason) => {
  console.error("[gateway][unhandledRejection]", reason);
  const now = Date.now();
  rejectionTimestamps.push(now);
  while (
    rejectionTimestamps.length > 0 &&
    now - rejectionTimestamps[0] > REJECTION_WINDOW_MS
  ) {
    rejectionTimestamps.shift();
  }
  if (rejectionTimestamps.length >= REJECTION_THRESHOLD) {
    console.error(
      `[gateway] ${rejectionTimestamps.length} unhandled rejections in ${REJECTION_WINDOW_MS}ms — exiting for supervisor restart`,
    );
    process.exit(1);
  }
});
// Installing a SIGHUP handler makes bun (and forked children up until
// exec) not die on the spurious SIGHUP that node-pty delivers to pty
// children on Bun/Linux. The pty wrapper installs a second, permanent
// SIG_IGN immediately after exec so the signal stays ignored in bash.
process.on("SIGHUP", () => {});

// ============================================================================
// CONFIGURATION
// ============================================================================

// Read LiteLLM proxy port from .proxy-port file in root directory
async function getLiteLLMUrl(): Promise<string> {
  try {
    const proxyPortFile = Bun.file("../.proxy-port");
    if (await proxyPortFile.exists()) {
      const port = (await proxyPortFile.text()).trim();
      return `http://localhost:${port}`;
    }
  } catch {
    // Fall through to default
  }
  return (
    process.env.LITELLM_URL ||
    process.env.LITELLM_PROXY_URL ||
    "http://localhost:4040"
  );
}

const litellmUrl = await getLiteLLMUrl();
const masterKey = process.env.LITELLM_MASTER_KEY || "";
const configPath = new URL("../config.yaml", import.meta.url).pathname;
const port = parseInt(process.env.GATEWAY_PORT || "14041");

initConfig(litellmUrl, masterKey, configPath, port);
await connectDB();
runPluginMigrations(gatewayPlugins);
await initCliSecret();

// ============================================================================
// ROUTE MANIFEST (built from route objects, served at /api/_routes)
// ============================================================================

const allRoutes = [
  authRoutes, keysRoutes, modelsRoutes, statsRoutes,
  userRoutes, adminRoutes, proxyRoutes, searchRoutes, healthRoutes, setupRoutes, skillsRoutes,
  pluginsRoutes, consoleRoutes, pluginRegistryRoutes,
];

function buildRouteManifest() {
  const routes: { method: string; path: string }[] = [];
  for (const routeObj of allRoutes) {
    for (const [path, methods] of Object.entries(routeObj)) {
      for (const method of Object.keys(methods as object)) {
        routes.push({ method: method.toUpperCase(), path });
      }
    }
  }
  routes.push({ method: "DELETE", path: "/api/keys/:id" });
  routes.push({ method: "PUT", path: "/api/keys/:id" });
  return routes;
}

const routeManifest = buildRouteManifest();

// ============================================================================
// INTERVALS
// ============================================================================

setInterval(() => {
  flushUsageQueue().catch((err) =>
    console.error("[gateway][flushUsageQueue]", err),
  );
}, 2000).unref();

setInterval(() => {
  try {
    const now = Date.now();
    for (const [ip, record] of rateLimitMap.entries()) {
      if (now - record.startTime > 3600000) rateLimitMap.delete(ip);
    }
    for (const [email, record] of otpRateLimitMap.entries()) {
      if (now - record.startTime > OTP_RATE_LIMIT_WINDOW_MS) otpRateLimitMap.delete(email);
    }
    sweepExpiredOtpsAndSessions();
  } catch (err) {
    console.error("[gateway][periodicCleanup]", err);
  }
}, 60000).unref();

// ============================================================================
// STATIC FILE HELPERS
// ============================================================================

// Serve frontend
async function serveFrontend() {
  const file = Bun.file("./index.html");
  return new Response(await file.text(), {
    headers: { "Content-Type": "text/html" },
  });
}

// Serve static files
async function serveStaticFile(path: string): Promise<Response | null> {
  const file = Bun.file(`.${path}`);
  if (await file.exists()) {
    const contentType = getContentType(path);
    return new Response(await file.arrayBuffer(), {
      headers: { "Content-Type": contentType },
    });
  }
  return null;
}

function getContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    css: "text/css",
    js: "application/javascript",
    mjs: "application/javascript",
    ts: "application/typescript",
    tsx: "application/typescript",
    html: "text/html",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
  };
  return types[ext || "text/plain"] || "text/plain";
}

// ============================================================================
// SERVER SETUP
// ============================================================================

Bun.serve({
  port: PORT,
  idleTimeout: 30,

  /** Catches handler throws so a bad value never becomes controller.error(null)-style crashes. */
  error(err: unknown) {
    console.error("[gateway]", errorMessage(err));
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  },

  routes: {
    // Static files
    "/public/*": async (req: Request) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const response = await serveStaticFile(path);
      return response || new Response("Not found", { status: 404 });
    },
    // Built frontend assets (output of: bun run build)
    "/frontend.tsx": async (_req: Request) => {
      const response = await serveStaticFile("/dist/frontend.js");
      return response
        ? new Response(await response.arrayBuffer(), {
            headers: { "Content-Type": "application/javascript" },
          })
        : new Response("Not found — run: bun run build", { status: 404 });
    },
    "/src/index.css": async (_req: Request) => {
      const response = await serveStaticFile("/dist/frontend.css");
      return response
        ? new Response(await response.arrayBuffer(), {
            headers: { "Content-Type": "text/css" },
          })
        : new Response("Not found — run: bun run build", { status: 404 });
    },

    // PWA manifest
    "/manifest.json": async (_req: Request) => {
      const response = await serveStaticFile("/public/manifest.json");
      return response || new Response("Not found", { status: 404 });
    },

    // Route manifest (for CLI auto-discovery)
    "/api/_routes": { GET: () => Response.json({ routes: routeManifest }) },

    // Auth, keys, models, stats, user, admin, proxy, search, health, setup, skills routes
    ...authRoutes,
    ...keysRoutes,
    ...modelsRoutes,
    ...statsRoutes,
    ...userRoutes,
    ...adminRoutes,
    ...proxyRoutes,
    ...searchRoutes,
    ...healthRoutes,
    ...setupRoutes,
    ...skillsRoutes,
    ...pluginsRoutes,
    ...consoleRoutes,
    ...pluginRegistryRoutes,

    // Icons (served from /public/)
    "/favicon.ico": async () => (await serveStaticFile("/public/favicon.ico")) || new Response("Not found", { status: 404 }),
    "/icon-16.png": async () => (await serveStaticFile("/public/icon-16.png")) || new Response("Not found", { status: 404 }),
    "/icon-32.png": async () => (await serveStaticFile("/public/icon-32.png")) || new Response("Not found", { status: 404 }),
    "/icon-128.png": async () => (await serveStaticFile("/public/icon-128.png")) || new Response("Not found", { status: 404 }),
    "/icon-192.png": async () => (await serveStaticFile("/public/icon-192.png")) || new Response("Not found", { status: 404 }),
    "/icon-512.png": async () => (await serveStaticFile("/public/icon-512.png")) || new Response("Not found", { status: 404 }),
    "/apple-touch-icon.png": async () => (await serveStaticFile("/public/apple-touch-icon.png")) || new Response("Not found", { status: 404 }),

    // Frontend - serve index.html for all UI routes
    "/auth": { GET: serveFrontend },
    "/keys": { GET: serveFrontend },
    "/settings": { GET: serveFrontend },
    "/admin": { GET: serveFrontend },
    "/console": { GET: serveFrontend },
    "/docs": { GET: serveFrontend },

    // Root → Overview
    "/": { GET: serveFrontend },
  },

  // Fallback for parameterized routes not matched by static routes
  async fetch(req: Request) {
    const url = new URL(req.url);

    // /api/keys/:id — DELETE, PUT
    if (url.pathname.startsWith("/api/keys/")) {
      const res = await handleKeyById(req);
      if (res) return res;
    }

    // /api/admin/teams/:id[/members[/:email]]
    if (url.pathname.startsWith("/api/admin/teams/")) {
      const res = await handleAdminTeamsByPath(req);
      if (res) return res;
    }

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    maxPayloadLength: 1 << 20, // 1 MiB — PTY traffic is tiny
    idleTimeout: 0,
    open(ws) {
      try {
        attachPty(ws as unknown as import("bun").ServerWebSocket<ConsoleSocketData>);
      } catch (err) {
        console.error("[console][open]", errorMessage(err));
        try { ws.send(`\r\n[error starting console: ${errorMessage(err)}]\r\n`); } catch {}
        try { ws.close(1011, "pty-failed"); } catch {}
      }
    },
    message(ws, message) {
      handleClientMessage(
        ws as unknown as import("bun").ServerWebSocket<ConsoleSocketData>,
        message,
      );
    },
    close(ws) {
      detachPty(ws as unknown as import("bun").ServerWebSocket<ConsoleSocketData>);
    },
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Server running at http://localhost:${PORT}`);
if (process.env.GATEWAY_DEV_NO_AUTH === "1") {
  const devEmail = process.env.GATEWAY_DEV_AUTH_EMAIL || "dev@localhost";
  console.warn(
    `⚠️  GATEWAY_DEV_NO_AUTH=1 — every request authenticates as ${devEmail} (admin). Local dev only.`,
  );
}
