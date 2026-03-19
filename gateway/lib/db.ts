import { MongoClient, type MongoClientOptions } from "mongodb";
import { createHash, randomBytes } from "crypto";
import { verifySession, getSessionCookie, extractApiKey } from "./auth";

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

export let db: any = null;
export let accessRequests: any = null;
export let apiKeys: any = null;
export let validatedUsers: any = null;
export let otps: any = null;
export let usageLogs: any = null;
export let sessions: any = null;

export async function connectDB(mongoUri: string) {
  if (db) return;

  const client = new MongoClient(mongoUri, {
    maxPoolSize: 20,
    minPoolSize: 5,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 8000,
  } as MongoClientOptions);

  await client.connect();
  db = client.db("llm-gateway");
  accessRequests = db.collection("access_requests");
  apiKeys = db.collection("api_keys");
  validatedUsers = db.collection("validated_users");
  otps = db.collection("otps");
  usageLogs = db.collection("usage_logs");
  sessions = db.collection("sessions");

  // Indexes (createIndex is a no-op if already exists)
  await apiKeys.createIndex({ key: 1 }, { unique: true });
  await apiKeys.createIndex({ keyHash: 1 }, { sparse: true });
  await validatedUsers.createIndex({ email: 1 }, { unique: true });
  await otps.createIndex({ email: 1, expiresAt: 1 });
  await sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
  // usage_logs: compound indexes covering all query patterns
  await usageLogs.createIndex({ email: 1, timestamp: -1 });
  await usageLogs.createIndex({ apiKeyHash: 1, timestamp: -1 });
  // group-items: model + timestamp for filtered time-range queries
  await usageLogs.createIndex({ email: 1, model: 1, timestamp: -1 });
  await usageLogs.createIndex({ email: 1, actualModel: 1, timestamp: -1 });

  console.log("✅ MongoDB connected (LLM Gateway - Bun Stack)");
}

// ============================================================================
// IN-MEMORY CACHES
// ============================================================================

export const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
export const userProfileCache = new Map<string, { user: any; timestamp: number }>();
export const apiKeyCache = new Map<string, { keyRecord: any; timestamp: number }>();

export async function loadUser(email: string) {
  const normalized = email.toLowerCase();
  const cached = userProfileCache.get(normalized);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.user;
  }
  const user = await validatedUsers.findOne({ email: normalized });
  if (user) {
    userProfileCache.set(normalized, { user, timestamp: Date.now() });
  }
  return user;
}

export async function validateApiKey(apiKey: string) {
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
// CLI SECRET (localhost bypass for litellmctl gateway api)
// ============================================================================

let _cliSecret: string | null = null;

export async function initCliSecret() {
  const secret = randomBytes(32).toString("hex");
  const secretFile = new URL("../../.gateway-secret", import.meta.url).pathname;
  await Bun.write(secretFile, secret);
  _cliSecret = secret;
}

// ============================================================================
// AUTH HELPERS
// ============================================================================

/**
 * Authenticate via API key or session cookie. Returns user or null.
 * This is the single entry point for all auth — every role gate below uses it.
 */
export async function getAuthenticatedUser(req: Request): Promise<{ email: string; role: string } | null> {
  // CLI secret bypass — localhost-only, reads from .gateway-secret
  const cliSecret = req.headers.get("x-gateway-secret");
  if (cliSecret && cliSecret === _cliSecret) {
    return { email: "cli@localhost", role: "admin" };
  }

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

// ── Standardized role gates ─────────────────────────────────────────────────
// Each returns the authenticated user on success, or a Response to send back.
// All support both API key and session auth via getAuthenticatedUser.

/** Any authenticated user (including guests). Equivalent to requiresApiKeyOrSession. */
export async function requireAuth(req: Request): Promise<{ email: string; role: string } | Response> {
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  return user;
}

/** Authenticated user with role "user" or "admin" (not guest). */
export async function requireUser(req: Request): Promise<{ email: string; role: string } | Response> {
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (user.role === "guest") return Response.json({ error: "User access required" }, { status: 403 });
  return user;
}

/** Authenticated user with role "admin" only. */
export async function requireAdmin(req: Request): Promise<{ email: string; role: string } | Response> {
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (user.role !== "admin") return Response.json({ error: "Admin access required" }, { status: 403 });
  return user;
}

// ============================================================================
// RATE LIMITING
// ============================================================================

export const rateLimitMap = new Map<string, { count: number; startTime: number }>();
export const otpRateLimitMap = new Map<string, { count: number; startTime: number }>();

export function checkOtpRateLimit(email: string): {
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

export async function flushUsageQueue() {
  if (_usageQueue.length === 0) return;
  const batch = _usageQueue.splice(0, _usageQueue.length);
  try {
    await usageLogs.insertMany(batch, { ordered: false });
  } catch (err) {
    console.error("⚠️ Usage batch insert failed:", (err as Error).message);
  }
}

// ── Pricing cache — populated from LiteLLM /model/info, refreshed every 5 min ──

let _pricingCache: Record<string, { input: number; output: number }> = {};
let _pricingCacheTs = 0;
const PRICING_CACHE_TTL_MS = 5 * 60 * 1000;

export async function refreshPricingCache() {
  const { LITELLM_URL, LITELLM_AUTH } = await import("./config");
  _pricingCacheTs = Date.now();
  try {
    const res = await fetch(`${LITELLM_URL}/model/info`, {
      headers: { Authorization: LITELLM_AUTH },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const fresh: Record<string, { input: number; output: number }> = {};
    for (const m of data.data || []) {
      const alias = m.model_name?.toLowerCase();
      if (!alias) continue;
      const mi = m.model_info || {};
      const lp = m.litellm_params || {};
      const inputPer = mi.input_cost_per_token ?? null;
      const outputPer = mi.output_cost_per_token ?? null;
      if (inputPer !== null && outputPer !== null) {
        fresh[alias] = { input: inputPer, output: outputPer };
        // Also index by underlying model name
        const underlying = (lp.model || "").toLowerCase();
        if (underlying && underlying !== alias) fresh[underlying] = fresh[alias];
      }
    }
    _pricingCache = fresh;
    console.log(`✅ Pricing cache refreshed: ${Object.keys(fresh).length} models`);
  } catch { /* silent fallback */ }
}

function getPricingRates(model: string): { input: number; output: number } | null {
  if (!model) return null;
  // Lazy refresh
  if (Date.now() - _pricingCacheTs > PRICING_CACHE_TTL_MS) {
    refreshPricingCache().catch(() => {});
  }
  const normalized = model.toLowerCase().replace(/-\d{8}$/, "");
  return _pricingCache[normalized] || _pricingCache[model.toLowerCase()] || null;
}

export function calcCost(model: string, promptTokens: number, completionTokens: number): number {
  const rates = getPricingRates(model);
  if (!rates) return 0;
  return promptTokens * rates.input + completionTokens * rates.output;
}

export function trackUsage(
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
