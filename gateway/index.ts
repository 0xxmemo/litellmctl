/**
 * LLM API Gateway - Bun Stack
 *
 * A lightweight authentication and rate-limiting proxy for LiteLLM.
 * Built with Bun.serve() for simplicity and performance.
 */

import { initConfig, PORT } from "./lib/config";
import { connectDB, flushUsageQueue, rateLimitMap, otpRateLimitMap, refreshPricingCache } from "./lib/db";
import { authRoutes } from "./routes/auth";
import { keysRoutes, handleKeyById } from "./routes/keys";
import { modelsRoutes } from "./routes/models";
import { statsRoutes } from "./routes/stats";
import { userRoutes } from "./routes/user";
import { adminRoutes } from "./routes/admin";
import { proxyRoutes } from "./routes/proxy";
import { searchRoutes } from "./routes/search";
import { healthRoutes } from "./routes/health";

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
await connectDB(process.env.GATEWAY_MONGODB_URI!);

// ============================================================================
// INTERVALS
// ============================================================================

setInterval(() => {
  flushUsageQueue().catch(() => {});
}, 2000).unref();

// Warm up pricing cache from LiteLLM /model/info (non-blocking)
refreshPricingCache().catch(() => {});

// Cleanup rate limit maps periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now - record.startTime > 3600000) rateLimitMap.delete(ip);
  }
  for (const [email, record] of otpRateLimitMap.entries()) {
    if (now - record.startTime > 3600000) otpRateLimitMap.delete(email);
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

    // Auth, keys, models, stats, user, admin, proxy, search, health routes
    ...authRoutes,
    ...keysRoutes,
    ...modelsRoutes,
    ...statsRoutes,
    ...userRoutes,
    ...adminRoutes,
    ...proxyRoutes,
    ...searchRoutes,
    ...healthRoutes,

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

    return new Response("Not found", { status: 404 });
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Server running at http://localhost:${PORT}`);
