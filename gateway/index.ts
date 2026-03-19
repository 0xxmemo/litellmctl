/**
 * LLM API Gateway - Bun Stack
 *
 * A lightweight authentication and rate-limiting proxy for LiteLLM.
 * Built with Bun.serve() for simplicity and performance.
 */

import { readFileSync } from "fs";
import { MongoClient, type MongoClientOptions } from "mongodb";

// Load environment variables from root .env file
try {
  const envPath = new URL("../.env", import.meta.url).pathname;
  const envText = readFileSync(envPath, "utf-8");
  envText.split('\n').forEach((line: string) => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      const value = valueParts.join('=').replace(/^["']|["']$/g, '');
      process.env[key.trim()] = value;
    }
  });
} catch {
  // .env file not found, use existing env vars
}
import {
  signSession,
  verifySession,
  getSessionCookie,
  extractApiKey,
} from "./lib/auth";
import { sendOTPCode } from "./lib/email-service";
import { generateOTP } from "./lib/otp";
import { createHash, randomBytes } from "crypto";

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

const LITELLM_URL = await getLiteLLMUrl();
const LITELLM_AUTH = `Bearer ${process.env.LITELLM_MASTER_KEY || ""}`;
const PORT = parseInt(process.env.GATEWAY_PORT || "14041");

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

let db: any = null;
let accessRequests: any = null;
let apiKeys: any = null;
let validatedUsers: any = null;
let otps: any = null;
let usageLogs: any = null;
let sessions: any = null;

async function connectDB() {
  if (db) return;

  const client = new MongoClient(process.env.GATEWAY_MONGODB_URI!, {
    maxPoolSize: 20,
    minPoolSize: 5,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
  } as MongoClientOptions);

  await client.connect();
  db = client.db("llm-gateway");
  accessRequests = db.collection("access_requests");
  apiKeys = db.collection("api_keys");
  validatedUsers = db.collection("validated_users");
  otps = db.collection("otps");
  usageLogs = db.collection("usage_logs");
  sessions = db.collection("sessions");

  // Indexes
  await apiKeys.createIndex({ key: 1 }, { unique: true });
  await apiKeys.createIndex({ keyHash: 1 }, { sparse: true });
  await validatedUsers.createIndex({ email: 1 }, { unique: true });
  await otps.createIndex({ email: 1, expiresAt: 1 });
  await usageLogs.createIndex({ apiKeyHash: 1, timestamp: -1 });
  await usageLogs.createIndex({ email: 1, timestamp: -1 });
  await usageLogs.createIndex({ timestamp: -1 });
  await sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });

  console.log("✅ MongoDB connected (LLM Gateway - Bun Stack)");
}

// ============================================================================
// IN-MEMORY CACHES
// ============================================================================

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const userProfileCache = new Map<string, { user: any; timestamp: number }>();
const apiKeyCache = new Map<string, { keyRecord: any; timestamp: number }>();

async function loadUser(email: string) {
  const cached = userProfileCache.get(email);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.user;
  }
  const user = await validatedUsers.findOne({ email });
  if (user) {
    userProfileCache.set(email, { user, timestamp: Date.now() });
  }
  return user;
}

async function validateApiKey(apiKey: string) {
  const keyHash = createHash("sha256").update(apiKey.trim()).digest("hex");

  const cached = apiKeyCache.get(keyHash);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.keyRecord;
  }

  const keyRecord = await apiKeys.findOne({ keyHash, revoked: false });
  if (keyRecord) {
    apiKeyCache.set(keyHash, { keyRecord, timestamp: Date.now() });
    return keyRecord;
  }

  // Legacy bcrypt fallback
  const bcrypt = await import("bcryptjs");
  const legacyKeys = await apiKeys
    .find({ revoked: false, keyType: { $ne: "sha256" } })
    .toArray();
  for (const k of legacyKeys) {
    const match = await bcrypt.default.compare(apiKey.trim(), k.key);
    if (match) {
      await apiKeys.updateOne(
        { _id: k._id },
        { $set: { keyHash, keyType: "sha256" } },
      );
      return k;
    }
  }

  return null;
}

// ============================================================================
// RATE LIMITING
// ============================================================================

const rateLimitMap = new Map<string, { count: number; startTime: number }>();
const otpRateLimitMap = new Map<string, { count: number; startTime: number }>();

function checkOtpRateLimit(email: string): {
  allowed: boolean;
  remaining?: number;
  retryAfterMin?: number;
} {
  const now = Date.now();
  const key = email.toLowerCase();
  const record = otpRateLimitMap.get(key);

  if (!record) {
    otpRateLimitMap.set(key, { count: 1, startTime: now });
    return { allowed: true, remaining: 3 };
  }

  if (now - record.startTime > 3600000) {
    record.count = 1;
    record.startTime = now;
    return { allowed: true, remaining: 3 };
  }

  if (record.count >= 3) {
    const retryAfterMs = 3600000 - (now - record.startTime);
    return { allowed: false, retryAfterMin: Math.ceil(retryAfterMs / 60000) };
  }

  record.count++;
  return { allowed: true, remaining: 3 - record.count };
}

// ============================================================================
// USAGE TRACKING (batched writes)
// ============================================================================

const _usageQueue: any[] = [];

async function flushUsageQueue() {
  if (_usageQueue.length === 0) return;
  const batch = _usageQueue.splice(0, _usageQueue.length);
  try {
    await usageLogs.insertMany(batch, { ordered: false });
  } catch (err) {
    console.error("⚠️ Usage batch insert failed:", (err as Error).message);
  }
}

setInterval(() => {
  flushUsageQueue().catch(() => {});
}, 2000).unref();

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 0.000005, output: 0.000025 },
  "claude-opus-4-5": { input: 0.000005, output: 0.000025 },
  "claude-sonnet-4-6": { input: 0.000003, output: 0.000015 },
  "claude-sonnet-4-5": { input: 0.000003, output: 0.000015 },
  "claude-haiku-4-5": { input: 0.000001, output: 0.000005 },
  "gpt-4o": { input: 0.0000025, output: 0.00001 },
  "gpt-4o-mini": { input: 0.00000015, output: 0.0000006 },
  sonnet: { input: 0.000003, output: 0.000015 },
  opus: { input: 0.000005, output: 0.000025 },
  haiku: { input: 0.000001, output: 0.000005 },
};

function calcCost(model: string, promptTokens: number, completionTokens: number): number {
  const rates = PRICING[model] ||
    PRICING[model?.replace(/-\d{8}$/, "") ?? ""] ||
    PRICING[model?.split("/").pop() ?? ""] ||
    { input: 0, output: 0 };
  return promptTokens * rates.input + completionTokens * rates.output;
}

function trackUsage(
  email: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  apiKeyHash: string | null,
  requestedModel?: string,
  endpoint?: string,
) {
  const cost = calcCost(model, promptTokens, completionTokens);
  _usageQueue.push({
    email,
    model,           // actual model (matches reference schema)
    actualModel: model,
    requestedModel: requestedModel || model,
    endpoint: endpoint || null,
    promptTokens,
    completionTokens,
    tokens: promptTokens + completionTokens,  // 'tokens' matches reference schema
    cost,
    apiKeyHash,
    timestamp: new Date(),
  });
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

// Health check
async function healthHandler() {
  return Response.json({ status: "ok", uptime: process.uptime() });
}

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

// OTP request
async function requestOtpHandler(req: Request) {
  const { email } = await req.json();

  if (!email || !email.includes("@")) {
    return Response.json({ error: "Valid email required" }, { status: 400 });
  }

  const limit = checkOtpRateLimit(email);
  if (!limit.allowed) {
    return Response.json(
      {
        error: `Too many attempts. Try again in ${limit.retryAfterMin} minutes.`,
      },
      { status: 429 },
    );
  }

  const code = generateOTP();
  await otps.insertOne({
    email: email.toLowerCase(),
    code,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    createdAt: new Date(),
  });

  const emailResult = await sendOTPCode(email, code);

  if (emailResult.warning) {
    return Response.json(
      { error: "Email service not configured. Ask the admin to set up ProtonMail SMTP." },
      { status: 503 },
    );
  }

  // Only set role if inserting a new user — never downgrade an existing admin/user
  await validatedUsers.updateOne(
    { email: email.toLowerCase() },
    {
      $set: { email: email.toLowerCase() },
      $setOnInsert: { role: "guest", createdAt: new Date() },
    },
    { upsert: true },
  );

  return Response.json({ success: true, message: "Code sent!" });
}

// OTP verification
async function verifyOtpHandler(req: Request) {
  const { email, otp } = await req.json();

  const otpRecord = await otps.findOne({
    email: email.toLowerCase(),
    code: otp,
    expiresAt: { $gt: new Date() },
  });

  if (!otpRecord) {
    return Response.json({ error: "Invalid or expired code" }, { status: 400 });
  }

  await otps.deleteOne({ _id: otpRecord._id });

  let user = await validatedUsers.findOne({ email: email.toLowerCase() });
  if (!user) {
    user = { email: email.toLowerCase(), role: "guest" as const, createdAt: new Date() };
    await validatedUsers.insertOne(user);
  }
  // Invalidate cache so fresh role is used
  userProfileCache.delete(email.toLowerCase());

  const actualRole = user.role || "guest";

  // Create session
  const sessionId = crypto.randomUUID();
  const sessionToken = await signSession({
    sessionId,
    userId: email.toLowerCase(),
    email: email.toLowerCase(),
    role: actualRole,
  });

  await sessions.insertOne({
    _id: sessionId,
    session: JSON.stringify({
      sessionId,
      userId: email.toLowerCase(),
      email: email.toLowerCase(),
      role: actualRole,
      cookie: { expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
    }),
    expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });

  const response = Response.json({ success: true, role: actualRole });
  response.headers.set(
    "Set-Cookie",
    `sessionId=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${365 * 24 * 60 * 60}`,
  );
  return response;
}

// Session status
async function sessionStatusHandler(req: Request) {
  const sessionToken = getSessionCookie(req);

  if (!sessionToken) {
    return Response.json({ authenticated: false });
  }

  const session = await verifySession(sessionToken);
  if (!session) {
    return Response.json({ authenticated: false });
  }

  const user = await loadUser(session.email);
  if (!user) {
    return Response.json({ authenticated: false });
  }

  return Response.json({
    authenticated: true,
    email: session.email,
    role: user.role,
  });
}

async function sessionMeHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken) return Response.json({ authenticated: false });
  const session = await verifySession(sessionToken);
  if (!session) return Response.json({ authenticated: false });
  const user = await loadUser(session.email);
  if (!user) return Response.json({ authenticated: false });
  return Response.json({
    authenticated: true,
    user: { email: session.email, role: user.role },
  });
}

// Logout
async function logoutHandler() {
  const response = Response.json({ success: true });
  response.headers.set(
    "Set-Cookie",
    "sessionId=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  );
  return response;
}

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

// Admin: pending requests
async function getPendingRequestsHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const user = await loadUser(session.email);
  if (!user || user.role !== "admin") {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }

  const requests = await accessRequests.find({ status: "pending" }).toArray();
  return Response.json({ requests });
}

// Admin: approve user
async function approveUserHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const user = await loadUser(session.email);
  if (!user || user.role !== "admin") {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }

  const { email } = await req.json();
  await validatedUsers.updateOne(
    { email: email.toLowerCase() },
    { $set: { role: "user", approvedAt: new Date() } },
  );

  userProfileCache.delete(email.toLowerCase());
  return Response.json({ success: true });
}

// LiteLLM Proxy
async function proxyHandler(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v1/, "");
  const targetUrl = `${LITELLM_URL}/v1${path}${url.search}`;

  const apiKey = extractApiKey(req);
  let email: string | null = null;
  let keyHash: string | null = null;

  if (apiKey) {
    const keyRecord = await validateApiKey(apiKey);
    if (!keyRecord) {
      return Response.json({ error: "Invalid API key" }, { status: 401 });
    }
    email = keyRecord.email;
    keyHash = keyRecord.keyHash;
  } else {
    const sessionToken = getSessionCookie(req);
    if (sessionToken) {
      const session = await verifySession(sessionToken);
      if (session) {
        const user = await loadUser(session.email);
        if (user && user.role !== "guest") {
          email = user.email;
        }
      }
    }
  }

  if (!email) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  // Read body for usage tracking
  const body = await req.text();
  let bodyObj: any = {};
  try {
    bodyObj = JSON.parse(body);
  } catch {}

  const model = bodyObj.model || "unknown";

  // Forward request
  const headers = new Headers(req.headers);
  headers.set("Authorization", LITELLM_AUTH);
  headers.delete("x-api-key");

  const proxyRes = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: body || undefined,
  });

  // Track usage for non-streaming responses
  if (proxyRes.ok && !bodyObj.stream) {
    try {
      const resClone = proxyRes.clone();
      const data = await resClone.json();
      const usage = data.usage;
      if (usage) {
        trackUsage(
          email!,
          model,
          usage.prompt_tokens || 0,
          usage.completion_tokens || 0,
          keyHash,
        );
      }
    } catch {}
  }

  return proxyRes;
}

// ============================================================================
// STATS HANDLERS
// ============================================================================

// Auth helper: returns user from session or API key, or null
async function getAuthenticatedUser(req: Request): Promise<{ email: string; role: string } | null> {
  const apiKey = extractApiKey(req);
  if (apiKey) {
    const keyRecord = await validateApiKey(apiKey);
    if (keyRecord) {
      const user = await loadUser(keyRecord.email);
      return user || null;
    }
    return null;
  }
  const sessionToken = getSessionCookie(req);
  if (!sessionToken) return null;
  const session = await verifySession(sessionToken);
  if (!session) return null;
  return await loadUser(session.email);
}

// GET /api/dashboard/global-stats — requiresApiKeyOrSession (any authenticated user incl. guests)
async function globalStatsHandler(req: Request) {
  const caller = await getAuthenticatedUser(req);
  if (!caller) return Response.json({ error: "Authentication required" }, { status: 401 });

  try {
    const [users, keys] = await Promise.all([
      validatedUsers.find({}).toArray(),
      apiKeys.find({ revoked: false }).toArray(),
    ]);

    // Try LiteLLM /global/spend
    let totalSpend = 0;
    try {
      const spendRes = await fetch(`${LITELLM_URL}/global/spend`, {
        headers: { Authorization: LITELLM_AUTH },
      });
      if (spendRes.ok) {
        const data = await spendRes.json();
        totalSpend = data.spend || data.total_spend || 0;
      }
    } catch {}

    // Model usage from MongoDB usage_logs
    // Handle both 'tokens' (reference) and 'totalTokens' (legacy field names)
    const tokensExpr = { $add: [{ $ifNull: ["$tokens", 0] }, { $ifNull: ["$totalTokens", 0] }] };
    const modelAgg = await usageLogs.aggregate([
      { $group: {
        _id: "$model",
        requests: { $sum: 1 },
        tokens: { $sum: tokensExpr },
        promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
        completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
      }},
      { $sort: { tokens: -1 } },
    ]).toArray();

    const totalTokensAgg = modelAgg.reduce((s: number, r: any) => s + Number(r.tokens || 0), 0);
    const totalRequests = modelAgg.reduce((s: number, r: any) => s + Number(r.requests || 0), 0);
    const totalTokens = totalTokensAgg;

    let calculatedSpend = 0;
    const modelUsage = modelAgg.map((r: any) => {
      const tok = Number(r.tokens || 0);
      const modelSpend = calcCost(r._id, Number(r.promptTokens || 0), Number(r.completionTokens || 0));
      calculatedSpend += modelSpend;
      return {
        model_name: r._id || "unknown",
        requests: Number(r.requests || 0),
        tokens: tok,
        spend: modelSpend,
        percentage: totalTokensAgg > 0 ? ((tok / totalTokensAgg) * 100).toFixed(1) : "0.0",
      };
    });
    // Use LiteLLM spend if available, otherwise fall back to calculated
    if (totalSpend === 0) totalSpend = calculatedSpend;

    // Top users from usage_logs
    const userKeyMap: Record<string, any[]> = {};
    for (const k of keys) {
      if (k.email) {
        userKeyMap[k.email] = userKeyMap[k.email] || [];
        userKeyMap[k.email].push(k);
      }
    }

    let topUsers: any[] = [];
    try {
      const usageAgg = await usageLogs.aggregate([
        { $group: {
          _id: "$email",
          requests: { $sum: 1 },
          tokens: { $sum: tokensExpr },
        }},
        { $sort: { requests: -1 } },
      ]).toArray();

      const emailUsageMap: Record<string, { requests: number; tokens: number }> = {};
      for (const row of usageAgg) {
        if (row._id) emailUsageMap[row._id] = { requests: Number(row.requests || 0), tokens: Number(row.tokens || 0) };
      }

      topUsers = users
        .filter((u: any) => u.email)
        .map((u: any) => {
          const userKeys = userKeyMap[u.email] || [];
          const usage = emailUsageMap[u.email] || { requests: 0, tokens: 0 };
          return { email: u.email, role: u.role || "user", requests: usage.requests, tokens: usage.tokens, spend: 0, keys: userKeys.length };
        })
        .filter((u: any) => u.keys > 0 || u.requests > 0)
        .sort((a: any, b: any) => (b.requests - a.requests) || (b.keys - a.keys));
    } catch {}

    return Response.json({ totalUsers: users.length, activeKeys: keys.length, totalSpend, totalRequests, totalTokens, modelUsage, topUsers });
  } catch (err) {
    console.error("global-stats error:", (err as Error).message);
    return Response.json({ error: "Failed to fetch global stats" }, { status: 500 });
  }
}

// GET /api/dashboard/user-stats
async function userStatsHandler(req: Request) {
  const user = await getAuthenticatedUser(req);
  if (!user || user.role === "guest") {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  try {
    const userKeys = await apiKeys.find({ email: user.email, revoked: false }).toArray();
    const keyHashes = userKeys.map((k: any) => k.keyHash).filter(Boolean);
    const matchClause = keyHashes.length
      ? { $or: [{ email: user.email }, { apiKeyHash: { $in: keyHashes } }] }
      : { email: user.email };

    const tokensExpr = { $add: [{ $ifNull: ["$tokens", 0] }, { $ifNull: ["$totalTokens", 0] }] };

    const [totals] = await usageLogs.aggregate([
      { $match: matchClause },
      { $group: {
        _id: null,
        requests: { $sum: 1 },
        tokens: { $sum: tokensExpr },
        promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
        completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
      }},
    ]).toArray();

    const modelBreakdown = await usageLogs.aggregate([
      { $match: matchClause },
      { $group: {
        _id: "$model",
        requests: { $sum: 1 },
        tokens: { $sum: tokensExpr },
        promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
        completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
        requestedAliases: { $addToSet: "$requestedModel" },
      }},
      { $sort: { tokens: -1 } },
    ]).toArray();

    const spend = modelBreakdown.reduce((sum: number, m: any) =>
      sum + calcCost(m._id, m.promptTokens || 0, m.completionTokens || 0), 0);
    const totalModelTokens = modelBreakdown.reduce((s: number, m: any) => s + m.tokens, 0);

    // Daily requests last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const dailyAgg = await usageLogs.aggregate([
      { $match: { ...matchClause, timestamp: { $gte: thirtyDaysAgo } } },
      { $group: {
        _id: { year: { $year: "$timestamp" }, month: { $month: "$timestamp" }, day: { $dayOfMonth: "$timestamp" } },
        requests: { $sum: 1 },
      }},
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]).toArray();

    const dailyMap: Record<string, number> = {};
    for (const e of dailyAgg) {
      const key = `${e._id.year}-${String(e._id.month).padStart(2,"0")}-${String(e._id.day).padStart(2,"0")}`;
      dailyMap[key] = e.requests;
    }

    const dailyRequests: { date: string; requests: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      dailyRequests.push({ date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), requests: dailyMap[key] || 0 });
    }

    return Response.json({
      requests: totals?.requests || 0,
      tokens: totals?.tokens || 0,
      promptTokens: totals?.promptTokens || 0,
      completionTokens: totals?.completionTokens || 0,
      spend,
      keys: userKeys.length,
      dailyRequests,
      modelUsage: modelBreakdown.map((m: any) => {
        const modelSpend = calcCost(m._id, m.promptTokens || 0, m.completionTokens || 0);
        const aliases = (m.requestedAliases || []).filter((a: string) => a && a !== m._id);
        return {
          model_name: m._id || "unknown",
          requested_aliases: aliases,
          requests: m.requests,
          tokens: m.tokens,
          cost: modelSpend,
          spend: modelSpend,
          percentage: totalModelTokens > 0 ? ((m.tokens / totalModelTokens) * 100).toFixed(1) : "0.0",
        };
      }),
    });
  } catch (err) {
    console.error("user-stats error:", (err as Error).message);
    return Response.json({ error: "Failed to fetch user stats" }, { status: 500 });
  }
}

// GET /api/overview/requests/grouped — requiresApiKeyOrSession (any authenticated user incl. guests)
async function groupedRequestsHandler(req: Request) {
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

    const userKeys = await apiKeys.find({ email: user.email, revoked: false }).toArray();
    const keyHashes = userKeys.map((k: any) => k.keyHash).filter(Boolean);
    const matchClause = keyHashes.length
      ? { $or: [{ email: user.email }, { apiKeyHash: { $in: keyHashes } }] }
      : { email: user.email };

    const [raw, totalRequests] = await Promise.all([
      usageLogs.find(matchClause).sort({ timestamp: -1 }).limit(10000).toArray(),
      usageLogs.countDocuments(matchClause),
    ]);

    // Group consecutive same model+endpoint requests
    const allGroups: any[] = [];
    let groupCounter = 0;
    for (const r of raw) {
      const model = r.actualModel || r.model || null;
      const endpoint = r.endpoint || null;
      const provider = model && model.includes("/") ? model.split("/")[0] : (model || "unknown");
      const groupKey = `${provider}|${model}|${endpoint}`;
      const cost = calcCost(model, r.promptTokens || 0, r.completionTokens || 0);
      const tokens = r.tokens || r.totalTokens || 0;
      const item = {
        _id: r._id.toString(),
        requestedModel: r.requestedModel || null,
        actualModel: model,
        endpoint,
        promptTokens: r.promptTokens || 0,
        completionTokens: r.completionTokens || 0,
        totalTokens: tokens,
        cost,
        timestamp: r.timestamp,
      };
      const lastGroup = allGroups.length > 0 ? allGroups[allGroups.length - 1] : null;
      if (lastGroup && lastGroup._groupKey === groupKey) {
        lastGroup.count += 1;
        lastGroup.totalTokens += tokens;
        lastGroup.totalSpend += cost;
        lastGroup.lastTimestamp = item.timestamp;
        lastGroup._itemIds.push(item._id);
      } else {
        groupCounter++;
        allGroups.push({
          id: `group-${groupCounter}`,
          _groupKey: groupKey,
          _itemIds: [item._id],
          provider,
          model,
          endpoint,
          count: 1,
          totalTokens: tokens,
          totalSpend: cost,
          firstTimestamp: item.timestamp,
          lastTimestamp: item.timestamp,
          items: null,
        });
      }
    }

    const totalGroups = allGroups.length;
    const totalPages = Math.ceil(totalGroups / pageSize);
    const offset = (page - 1) * pageSize;
    const pageGroups = allGroups.slice(offset, offset + pageSize).map(({ _groupKey, _itemIds, ...g }) => g);

    return Response.json({
      groups: pageGroups,
      pagination: { page, pageSize, totalGroups, totalPages, hasMore: page < totalPages, totalRequests },
    });
  } catch (err) {
    console.error("grouped-requests error:", (err as Error).message);
    return Response.json({ error: "Failed to fetch grouped requests" }, { status: 500 });
  }
}

// ============================================================================
// ADMIN HANDLERS
// ============================================================================

async function requireAdmin(req: Request): Promise<{ email: string; role: string } | Response> {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken) return Response.json({ error: "Authentication required" }, { status: 401 });
  const session = await verifySession(sessionToken);
  if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });
  const user = await loadUser(session.email);
  if (!user || user.role !== "admin") return Response.json({ error: "Admin access required" }, { status: 403 });
  return user;
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
const CONFIG_PATH = new URL("../config.yaml", import.meta.url).pathname;

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

// ============================================================================
// SERVER SETUP
// ============================================================================

await connectDB();

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

Bun.serve({
  port: PORT,

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

    // Health
    "/api/health": { GET: healthHandler },

    // Auth
    "/api/auth/request-otp": { POST: requestOtpHandler },
    "/api/auth/verify-otp": { POST: verifyOtpHandler },
    "/api/auth/status": { GET: sessionStatusHandler },
    "/api/auth/me": { GET: sessionMeHandler },
    "/api/auth/logout": { GET: logoutHandler },

    // API Keys
    "/api/keys": { GET: getApiKeysHandler, POST: createApiKeyHandler },
    "/api/keys/revoke": { POST: revokeApiKeyHandler },

    // Models
    "/api/models": { GET: getModelsHandler },

    // Dashboard stats
    "/api/dashboard/global-stats": { GET: globalStatsHandler },
    "/api/dashboard/user-stats": { GET: userStatsHandler },
    "/api/overview/requests/grouped": { GET: groupedRequestsHandler },

    // Admin — users
    "/api/admin/users": { GET: adminListUsersHandler, POST: adminCreateUserHandler },
    "/api/admin/users/*": { DELETE: adminDeleteUserHandler },
    "/api/admin/approve": { POST: approveUserHandler },
    "/api/admin/reject": { POST: adminRejectUserHandler },
    "/api/admin/disapprove-all": { POST: adminDisapproveAllHandler },
    "/api/admin/keys/revoke-all": { POST: adminRevokeAllKeysHandler },
    "/api/admin/pending": { GET: getPendingRequestsHandler },

    // Admin — config
    "/api/admin/litellm-config": { GET: adminGetConfigHandler, PATCH: adminUpdateConfigHandler },
    "/api/admin/litellm-config/reset": { POST: adminResetConfigHandler },

    // Proxy (LiteLLM)
    "/v1/chat/completions": { POST: proxyHandler },
    "/v1/embeddings": { POST: proxyHandler },
    "/v1/completions": { POST: proxyHandler },
    "/v1/audio/transcriptions": { POST: proxyHandler },
    "/v1/models": { GET: proxyHandler },
    "/v1/model/info": { GET: proxyHandler },

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

  development: {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Server running at http://localhost:${PORT}`);
