import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { proxy as honoProxy } from 'hono/proxy';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'hono-sess';
import bcrypt from 'bcryptjs';
import pkg from 'pg';
const { Pool } = pkg;
import { MongoStore } from './src/session.ts';
import { requireSession, requireRole, requireAdmin, requireUserOrAdmin, requireUser } from './middleware/auth.js';
import { detectIsStub, buildExtendedModel, resolveProvider } from '@/lib/models';
import { verifyConnection, sendOTPCode, sendAdminNotification } from './email-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// LiteLLM proxy URL (single source of truth — also accepts legacy LITELLM_PROXY_URL)
const LITELLM_URL = process.env.LITELLM_URL || process.env.LITELLM_PROXY_URL || 'http://localhost:4040';

// Pre-built auth header for LiteLLM (avoids string concat on every request)
const _litellmAuthHeader = `Bearer ${process.env.LITELLM_MASTER_KEY || ''}`;

// ── LiteLLM PostgreSQL pool (direct DB access for global stats) ─────────────
// DATABASE_URL comes from LiteLLM's own config — same DB, read-only queries.
const _pgPool = new Pool({
  connectionString: process.env.LITELLM_DATABASE_URL || process.env.DATABASE_URL,
});
_pgPool.on('error', (err) => console.error('PG pool error:', err.message));

// Pre-encoded auth header bytes for fast header injection
// Context keys used throughout the proxy pipeline
const CTX_USER = 'user';
const CTX_API_KEY = 'apiKey';
const CTX_API_KEY_HASH = 'apiKeyHash'; // pre-computed SHA-256, avoids re-hashing in trackUsage
const CTX_SESSION = 'session';
const CTX_VALIDATED_USERS = 'validatedUsers';
const CTX_ACCESS_REQUESTS = 'accessRequests';
const CTX_API_KEYS = 'apiKeys';

// ── In-memory model overrides cache ────────────────────────────────────────
// Map<email, { overrides: object, timestamp: number }>
// Avoids a MongoDB round-trip on every proxied request for tier-alias resolution.
const modelOverridesCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedOverrides(email) {
  const cached = modelOverridesCache.get(email);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    modelOverridesCache.delete(email);
    return null;
  }
  return cached.overrides;
}

function setCachedOverrides(email, overrides) {
  modelOverridesCache.set(email, { overrides, timestamp: Date.now() });
}

function invalidateOverridesCache(email) {
  modelOverridesCache.delete(email);
}

// ── In-memory user profile cache ────────────────────────────────────────────
// Map<email, { user: object, timestamp: number }>
// Caches validated_users lookups — avoids a MongoDB query on every session request.
// TTL: 5 minutes (same as overrides). Invalidated explicitly on role/status changes.
const userProfileCache = new Map();
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedUser(email) {
  const cached = userProfileCache.get(email);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > USER_CACHE_TTL) {
    userProfileCache.delete(email);
    return null;
  }
  return cached.user;
}

function setCachedUser(email, user) {
  userProfileCache.set(email, { user, timestamp: Date.now() });
}

function invalidateUserCache(email) {
  userProfileCache.delete(email);
}

// ── In-memory API key cache ──────────────────────────────────────────────────
// Map<keyHash, { keyRecord: object, timestamp: number }>
// Caches SHA-256 API key lookups so repeated requests don't hit MongoDB every time.
// TTL: 5 minutes. Invalidated explicitly on key revocation.
const apiKeyCache = new Map();
const API_KEY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedApiKey(keyHash) {
  const cached = apiKeyCache.get(keyHash);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > API_KEY_CACHE_TTL) {
    apiKeyCache.delete(keyHash);
    return null;
  }
  return cached.keyRecord;
}

function setCachedApiKey(keyHash, keyRecord) {
  apiKeyCache.set(keyHash, { keyRecord, timestamp: Date.now() });
}

function invalidateApiKeyCache(keyHash) {
  apiKeyCache.delete(keyHash);
}

// Periodic cleanup: remove stale entries every 10 minutes to prevent memory bloat
setInterval(() => {
  const now = Date.now();
  for (const [email, entry] of modelOverridesCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      modelOverridesCache.delete(email);
    }
  }
  for (const [email, entry] of userProfileCache.entries()) {
    if (now - entry.timestamp > USER_CACHE_TTL) {
      userProfileCache.delete(email);
    }
  }
  for (const [hash, entry] of apiKeyCache.entries()) {
    if (now - entry.timestamp > API_KEY_CACHE_TTL) {
      apiKeyCache.delete(hash);
    }
  }
}, 10 * 60 * 1000).unref();

/**
 * Fetch wrapper for LiteLLM.
 * Node.js v18+ pools HTTP/1.1 connections internally — no need for a manual http.Agent.
 * For Hono proxy routes we use honoProxy() directly; this helper is kept for metadata
 * endpoints (model/info, global/spend, etc.) that need JSON responses.
 */
function litellmFetch(urlPath, options = {}) {
  return fetch(`${LITELLM_URL}${urlPath}`, options);
}

// ── Extended model metadata ───────────────────────────────────────────────────
// buildExtendedModel() and resolveProvider() are imported from src/lib/models.ts —
// single source of truth for all model metadata. No duplicate logic here.

/**
 * Fetches extended model data from LiteLLM.
 * Uses buildExtendedModel() from src/lib/models.ts (no duplicate code).
 */
async function fetchExtendedModels() {
  const res = await litellmFetch('/model/info', {
    headers: { 'Authorization': _litellmAuthHeader },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`LiteLLM /model/info returned ${res.status}`);
  const data = await res.json();
  // Deduplicate by model_name — LiteLLM sometimes returns each model N times
  // (one per configured router entry). Keep only the first occurrence of each name.
  const seen = new Set();
  const unique = (data.data || []).filter(entry => {
    const name = entry.model_name;
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const models = unique.map(buildExtendedModel);
  return { models, count: models.length };
}

// Database collections
let db = null;
let accessRequests = null;
let apiKeys = null;
let validatedUsers = null;
let otps = null;
let usageLogs = null;

async function connectDB() {
  if (db) return;
  // Connection pool: min 5, max 20 connections for concurrent requests
  const client = new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 20,
    minPoolSize: 5,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 10000,
  });
  await client.connect();
  db = client.db('llm-gateway');
  accessRequests = db.collection('access_requests');
  apiKeys = db.collection('api_keys');
  validatedUsers = db.collection('validated_users');
  otps = db.collection('otps');
  usageLogs = db.collection('usage_logs');
  
  await apiKeys.createIndex({ key: 1 }, { unique: true });
  await apiKeys.createIndex({ keyHash: 1 }, { sparse: true });
  await validatedUsers.createIndex({ email: 1 }, { unique: true });
  await otps.createIndex({ email: 1, expiresAt: 1 });
  // usage_logs indexes for fast per-user/per-key aggregations
  await usageLogs.createIndex({ apiKeyHash: 1, timestamp: -1 });
  await usageLogs.createIndex({ email: 1, timestamp: -1 });
  await usageLogs.createIndex({ model: 1, timestamp: -1 });
  await usageLogs.createIndex({ timestamp: -1 });
  // sessions: TTL index auto-removes expired sessions via MongoDB native TTL
  const sessions = db.collection('sessions');
  await sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });

  console.log('✅ MongoDB connected (LLM Gateway - Thin Proxy)');
}

const app = new Hono();

// CORS
app.use('*', cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'Content-Type', 'Authorization', 'Cookie',
    // API key header variants (all common CLI / SDK formats)
    'x-api-key', 'X-API-Key', 'X-Api-Key',
    // Anthropic / Claude Code SDK headers
    'anthropic-version', 'anthropic-beta',
    // OpenAI SDK / misc
    'OpenAI-Organization', 'x-stainless-lang', 'x-stainless-package-version',
    'x-stainless-os', 'x-stainless-arch', 'x-stainless-runtime',
    'x-stainless-runtime-version',
  ],
  credentials: true,
}));

// Rate limiting
const rateLimitMap = new Map();
function rateLimit(windowMs = 60000, limit = 100) {
  return async (c, next) => {
    const ip = c.req.header('x-forwarded-for') || 'unknown';
    const now = Date.now();
    if (!rateLimitMap.has(ip)) {
      rateLimitMap.set(ip, { count: 1, startTime: now });
    } else {
      const record = rateLimitMap.get(ip);
      if (now - record.startTime > windowMs) {
        record.count = 1;
        record.startTime = now;
      } else {
        record.count++;
        if (record.count > limit) return c.json({ error: 'Too many requests' }, 429);
      }
    }
    await next();
  };
}
app.use('*', rateLimit());

// Per-email OTP rate limiting: max 3 OTP requests per email per hour
const otpRateLimitMap = new Map();
const OTP_RATE_LIMIT_MAX = 3;
const OTP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkOtpRateLimit(email) {
  const now = Date.now();
  const key = email.toLowerCase();
  if (!otpRateLimitMap.has(key)) {
    otpRateLimitMap.set(key, { count: 1, startTime: now });
    return { allowed: true, remaining: OTP_RATE_LIMIT_MAX - 1 };
  }
  const record = otpRateLimitMap.get(key);
  if (now - record.startTime > OTP_RATE_LIMIT_WINDOW_MS) {
    // Window expired, reset
    record.count = 1;
    record.startTime = now;
    return { allowed: true, remaining: OTP_RATE_LIMIT_MAX - 1 };
  }
  if (record.count >= OTP_RATE_LIMIT_MAX) {
    const retryAfterMs = OTP_RATE_LIMIT_WINDOW_MS - (now - record.startTime);
    const retryAfterMin = Math.ceil(retryAfterMs / 60000);
    return { allowed: false, retryAfterMin };
  }
  record.count++;
  return { allowed: true, remaining: OTP_RATE_LIMIT_MAX - record.count };
}

// Connect DB
await connectDB();

// Session middleware
// touchAfter: 86400s = 1 day — session touch only written to MongoDB once/day per session
// This dramatically reduces DB writes for active users while keeping expiry accurate.
const mongoStore = new MongoStore(process.env.MONGODB_URI, 'llm-gateway', 'sessions', { touchAfter: 86400 });
app.use('*', session({
  secret: process.env.SESSION_SECRET || 'your-secret-min-32-chars',
  store: mongoStore,
  // proxy: true — trust X-Forwarded-Proto from nginx/Caddy so secure cookies are sent
  // without this, hono-sess sees http://localhost and refuses to set secure:true cookies
  proxy: true,
  // sameSite: true maps to 'strict' in hono-sess expressCookieOptionsToHonoCookieOptions
  // (hono-sess 0.10.2 bug: string 'strict'/'lax' → undefined; only booleans and 'none' work)
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: true, maxAge: 365 * 24 * 60 * 60 * 1000, path: '/' },
  resave: false, saveUninitialized: false, rolling: true
}));

// Make DB collections available to middleware
app.use('*', async (c, next) => {
  c.set(CTX_VALIDATED_USERS, validatedUsers);
  c.set(CTX_ACCESS_REQUESTS, accessRequests);
  c.set(CTX_API_KEYS, apiKeys);
  await next();
});

// Load user from session (with in-memory cache to avoid per-request MongoDB queries)
app.use('*', async (c, next) => {
  const sess = c.req.session;
  if (sess && sess.email && sess.userId) {
    // Check in-memory cache first — avoids MongoDB round-trip on repeat requests
    let user = getCachedUser(sess.email);
    if (!user) {
      user = await validatedUsers.findOne({ email: sess.email });
      if (user) setCachedUser(sess.email, user);
    }
    if (user) {
      c.set(CTX_USER, user);
      c.set(CTX_SESSION, { userId: sess.userId, email: sess.email, user });
    }
  }
  await next();
});

// ============ API KEY EXTRACTION ============
/**
 * Extract API key from request, supporting all common CLI/SDK auth formats:
 *   1. Authorization: Bearer sk-xxx  (standard Bearer token)
 *   2. Authorization: sk-xxx         (plain token, no prefix)
 *   3. x-api-key: sk-xxx             (OpenAI-style header, any casing)
 *   4. X-API-Key: sk-xxx             (uppercase variant — same as above via case-insensitive lookup)
 *
 * Header lookup is case-insensitive (Web API Headers.get() spec).
 * Returns the raw key string, or null if no auth header is present.
 */
function extractApiKey(c) {
  // 1 & 2: Authorization header (with or without "Bearer " prefix)
  const authHeader = c.req.header('Authorization');
  if (authHeader) {
    const key = authHeader.startsWith('Bearer ') || authHeader.startsWith('bearer ')
      ? authHeader.replace(/^Bearer\s+/i, '').trim()
      : authHeader.trim();
    if (key) return key;
  }

  // 3 & 4: x-api-key / X-API-Key (case-insensitive via Headers.get)
  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader) return apiKeyHeader.trim();

  return null;
}

// ============ API KEY GATING MIDDLEWARE ============
// Pre-import crypto (shared across auth middleware and trackUsage)
const { createHash: _authCreateHash } = await import('crypto');
const _createHash = _authCreateHash; // alias for trackUsage

async function requiresApiKeyOrSession(c, next) {
  const apiKey = extractApiKey(c);

  if (apiKey) {
    // SHA-256 hash for O(1) lookup
    const keyHash = _authCreateHash('sha256').update(apiKey.trim()).digest('hex');

    // 1. Check in-memory cache — avoids MongoDB on repeat API key requests
    let keyRecord = getCachedApiKey(keyHash);

    if (!keyRecord) {
      // 2. Fast path: SHA-256 O(1) MongoDB lookup — no bcrypt
      keyRecord = await apiKeys.findOne({ keyHash, revoked: false });

      // 3. Legacy path: bcrypt comparison for keys created before SHA-256 migration.
      //    Only runs if fast-path misses AND legacy keys exist.
      if (!keyRecord) {
        const legacyKeys = await apiKeys.find({ revoked: false, keyType: { $ne: 'sha256' } }).toArray();
        for (const k of legacyKeys) {
          const match = await bcrypt.compare(apiKey.trim(), k.key);
          if (match) {
            keyRecord = k;
            // Migrate to SHA-256 for O(1) lookup from now on
            apiKeys.updateOne({ _id: k._id }, { $set: { keyHash, keyType: 'sha256' } }).catch(() => {});
            break;
          }
        }
      }

      // Cache the result (only valid, non-revoked keys)
      if (keyRecord) setCachedApiKey(keyHash, keyRecord);
    }

    if (keyRecord) {
      c.set(CTX_API_KEY, keyRecord);
      // Store pre-computed hash so trackUsage() doesn't re-hash
      c.set(CTX_API_KEY_HASH, keyHash);
      return next();
    }
    return c.json({ error: 'Invalid API key' }, 401);
  }

  if (c.get(CTX_USER)) return next();
  return c.json({ error: 'Authentication required' }, 401);
}

// ============ USAGE TRACKING ============

/**
 * In-memory pricing cache — populated from LiteLLM /model/info, refreshed every 5 min.
 * Fallback static map covers common models so cold-cache never blocks a request.
 * Schema: { [modelAlias]: { input: $/token, output: $/token } }
 *
 * Philosophy: DB stores raw events only. Costs are calculated at query time.
 */
const STATIC_PRICING = {
  // Anthropic — prefixed names are canonical; unprefixed kept for backward compat
  'anthropic/claude-opus-4-6':   { input: 0.000005,    output: 0.000025   },
  'anthropic/claude-sonnet-4-5': { input: 0.000003,    output: 0.000015   },
  'anthropic/claude-sonnet-4-6': { input: 0.000003,    output: 0.000015   },
  'anthropic/claude-haiku-4-5':  { input: 0.000001,    output: 0.000005   },
  'anthropic/claude-opus-4-5':   { input: 0.000005,    output: 0.000025   },
  // Legacy unprefixed fallbacks
  'claude-opus-4-6':             { input: 0.000005,    output: 0.000025   },
  'claude-sonnet-4-5':           { input: 0.000003,    output: 0.000015   },
  'claude-sonnet-4-6':           { input: 0.000003,    output: 0.000015   },
  'claude-haiku-4-5':            { input: 0.000001,    output: 0.000005   },
  'claude-opus-4-5':             { input: 0.000005,    output: 0.000025   },
  // Alibaba Qwen — prefixed canonical
  'alibaba/qwen3.5-plus':        { input: 0.000005,    output: 0.000025   },
  'alibaba/qwen3-coder-plus':    { input: 0.000005,    output: 0.000025   },
  'alibaba/qwen3-coder-next':    { input: 0.00000358,  output: 0.00001433 },
  // Legacy unprefixed fallbacks
  'qwen3.5-plus':                { input: 0.000005,    output: 0.000025   },
  'qwen3-coder-plus':            { input: 0.000005,    output: 0.000025   },
  'qwen3-coder-next':            { input: 0.00000358,  output: 0.00001433 },
  // OpenAI
  'openai/gpt-4o':               { input: 0.0000025,   output: 0.00001    },
  'openai/gpt-4o-mini':          { input: 0.00000015,  output: 0.0000006  },
  'openai/gpt-4':                { input: 0.00003,     output: 0.00006    },
  'openai/gpt-3.5-turbo':        { input: 0.000001,    output: 0.000002   },
  'gpt-4o':                      { input: 0.0000025,   output: 0.00001    },
  'gpt-4o-mini':                 { input: 0.00000015,  output: 0.0000006  },
  'gpt-4':                       { input: 0.00003,     output: 0.00006    },
  'gpt-3.5-turbo':               { input: 0.000001,    output: 0.000002   },
  // Google
  'google/gemini-pro':           { input: 0.00000025,  output: 0.0000005  },
  'google/gemini-1.5-pro':       { input: 0.00000125,  output: 0.000005   },
  'google/gemini-1.5-flash':     { input: 0.000000075, output: 0.0000003  },
  'gemini-pro':                  { input: 0.00000025,  output: 0.0000005  },
  'gemini-1.5-pro':              { input: 0.00000125,  output: 0.000005   },
  'gemini-1.5-flash':            { input: 0.000000075, output: 0.0000003  },
  // Short alias names (as returned by LiteLLM model_name for custom deployments)
  // These get resolved by refreshPricingCache → underlying model lookup.
  // The static entries here serve as fallback if cache refresh fails.
  // Legacy names (kept for backward compatibility)
  'sonnet':      { input: 0.000003, output: 0.000015  }, // → anthropic/claude-sonnet-4-6
  'opus':        { input: 0.000005, output: 0.000025  }, // → anthropic/claude-opus-4-6
  'haiku':       { input: 0.000001, output: 0.000005  }, // → anthropic/claude-haiku-4-5
  // New alias names (renamed tiers)
  'ultra':       { input: 0.000005, output: 0.000025  }, // → most capable tier
  'plus':        { input: 0.000003, output: 0.000015  }, // → balanced tier
  'lite':        { input: 0.000001, output: 0.000005  }, // → fast & lightweight tier
};

let _pricingCache = { ...STATIC_PRICING };
let _pricingCacheTs = 0;
const PRICING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getPricingRates(modelAlias) {
  // Trigger background refresh if stale (non-blocking)
  if (Date.now() - _pricingCacheTs > PRICING_CACHE_TTL_MS) {
    refreshPricingCache().catch(() => {});
  }
  if (!modelAlias) return null;
  const normalized = modelAlias.replace(/-\d{8}$/, '').toLowerCase();
  return _pricingCache[normalized] || _pricingCache[modelAlias] || null;
}

async function refreshPricingCache() {
  _pricingCacheTs = Date.now(); // mark attempted even on failure
  try {
    const res = await litellmFetch('/model/info', {
      headers: { 'Authorization': _litellmAuthHeader },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const models = data.data || [];
    const fresh = { ...STATIC_PRICING };
    for (const m of models) {
      const alias = m.model_name?.toLowerCase();
      if (!alias) continue;
      const lp = m.litellm_params || {};

      // Try explicit cost fields first
      const inputPer = m.input_cost_per_token ?? lp.input_cost_per_token ?? null;
      const outputPer = m.output_cost_per_token ?? lp.output_cost_per_token ?? null;
      if (inputPer !== null && outputPer !== null) {
        fresh[alias] = { input: inputPer, output: outputPer };
        const underlying = (lp.model || '').toLowerCase();
        if (underlying && underlying !== alias) fresh[underlying] = fresh[alias];
      } else {
        // No explicit cost — resolve alias via underlying model name
        // e.g. alias="sonnet" -> underlying="anthropic/claude-sonnet-4-6" -> look up static pricing
        const underlying = (lp.model || '').toLowerCase();
        if (underlying && underlying !== alias) {
          const underlyingNorm = underlying.replace(/-\d{8}$/, '');
          const rates = fresh[underlying] || fresh[underlyingNorm] || null;
          if (rates) fresh[alias] = rates;
        }
      }
    }
    _pricingCache = fresh;
  } catch (_e) {
    // Silently fall back to static pricing
  }
}

/**
 * Calculate spend from raw token counts using the pricing cache.
 * Returns 0 for unknown models. Never throws.
 */
function calcCost(model, promptTokens, completionTokens) {
  const rates = getPricingRates(model);
  if (!rates) return 0;
  return (promptTokens * rates.input) + (completionTokens * rates.output);
}

// Kick off initial pricing cache warm-up in background
refreshPricingCache().catch(() => {});

// ── Alias→ActualModel resolution map ───────────────────────────────────────
// LiteLLM returns the alias name (e.g. "opus") in response.model when a
// model_group_alias is used. We build a map from alias → primary actual model
// at startup by querying LiteLLM's model info endpoint.
// This is best-effort: if LiteLLM is down, we fall back to a static map.
const ALIAS_TO_MODEL = new Map();

// ── Tier/stub aliases only (model_group_alias from router_settings) ───────────
// These are the short user-facing aliases (opus, sonnet, haiku, ultra, plus, etc.)
// that users can override. Separate from ALIAS_TO_MODEL which also includes
// model_list aliases (provider model renames). Only this map is exposed to users
// in the Model Overrides settings panel.
const MODEL_GROUP_ALIAS = new Map();

// ── Known model IDs from LiteLLM (/v1/models) ────────────────────────────────
// Used for validation only — not for prefix stripping.
// We prefer provider-prefixed model names (e.g. "anthropic/claude-opus-4-6") everywhere.
// Refreshed at startup and every 5 minutes in the background.
let _knownModelIds = new Set();
let _knownModelIdsCacheTs = 0;
const KNOWN_MODELS_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function refreshKnownModelIds() {
  _knownModelIdsCacheTs = Date.now();
  try {
    const res = await litellmFetch('/v1/models', {
      headers: { Authorization: _litellmAuthHeader },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const ids = new Set((data.data || []).map(m => m.id).filter(Boolean));
    if (ids.size > 0) {
      _knownModelIds = ids;
      console.log(`✅ Known models refreshed: ${ids.size} entries`);
    }
  } catch (err) {
    console.warn('⚠️  Could not refresh known model IDs:', err.message);
  }
}

/**
 * Normalize a model name — passes through as-is.
 * We now prefer provider-prefixed model names (provider/model-name) everywhere.
 * LiteLLM handles prefixed names natively via the config model_list.
 *
 * This function is kept as a no-op pass-through for backward compatibility.
 * Previously it stripped prefixes; now we preserve them.
 */
function normalizeModelName(modelName) {
  return modelName;
}

async function buildAliasMap() {
  try {
    // Fetch both model/info AND config in parallel to capture all alias types:
    // - model_list aliases: where model_name != litellm_params.model
    // - model_group_alias: short names like opus/sonnet/haiku in router_settings
    const [modelInfoRes, configRes] = await Promise.allSettled([
      litellmFetch('/v1/model/info', {
        headers: { Authorization: _litellmAuthHeader },
        signal: AbortSignal.timeout(8000),
      }),
      litellmFetch('/config', {
        headers: { Authorization: _litellmAuthHeader },
        signal: AbortSignal.timeout(8000),
      }),
    ]);

    // Build a fresh map (replace entire map atomically)
    const freshMap = new Map();

    // From /v1/model/info: model_name != litellm_params.model → it's an alias
    if (modelInfoRes.status === 'fulfilled' && modelInfoRes.value.ok) {
      const data = await modelInfoRes.value.json();
      for (const m of (data.data || [])) {
        const alias = m.model_name;
        const actual = m.litellm_params?.model;
        if (alias && actual && alias !== actual) {
          freshMap.set(alias, actual);
        }
      }
    }

    // CRITICAL FIX: From /config: router_settings.model_group_alias
    // These are short aliases like opus → codex/gpt-5.3-codex that are NOT
    // in model_list at all — they only exist in router_settings.
    const freshGroupAlias = new Map();
    if (configRes.status === 'fulfilled' && configRes.value.ok) {
      const cfg = await configRes.value.json();
      const groupAlias = cfg.router_settings?.model_group_alias || {};
      for (const [alias, resolved] of Object.entries(groupAlias)) {
        // model_group_alias entries take priority (they're explicit admin config)
        freshMap.set(alias, resolved);
        // Also track separately for the user-facing Model Overrides panel
        freshGroupAlias.set(alias, resolved);
      }
    }

    // Atomic swap — replace the module-level maps
    ALIAS_TO_MODEL.clear();
    for (const [k, v] of freshMap) {
      ALIAS_TO_MODEL.set(k, v);
    }
    MODEL_GROUP_ALIAS.clear();
    for (const [k, v] of freshGroupAlias) {
      MODEL_GROUP_ALIAS.set(k, v);
    }

    console.log(`✅ Alias map built: ${ALIAS_TO_MODEL.size} entries (${MODEL_GROUP_ALIAS.size} tier aliases in model_group_alias)`);
  } catch (err) {
    console.warn('⚠️  Could not build alias map from LiteLLM:', err.message);
  }
}

// Warm up alias map + known model IDs in background (non-blocking)
buildAliasMap().catch(() => {});
refreshKnownModelIds().catch(() => {}); // still needed for alias map building

// Periodic alias map refresh — every 5 minutes (keeps map in sync with LiteLLM config changes
// and recovers from startup failures when LiteLLM wasn't ready yet)
setInterval(() => { buildAliasMap().catch(() => {}); }, 5 * 60 * 1000);

/**
 * Resolve a model name: if it's a known alias, return the actual model.
 * Falls back to the input value if no mapping exists.
 */
function resolveActualModel(modelName) {
  if (!modelName) return modelName;
  // If alias map is empty (startup failed), try to rebuild it in background
  if (ALIAS_TO_MODEL.size === 0) {
    buildAliasMap().catch(() => {});
  }
  return ALIAS_TO_MODEL.get(modelName) || modelName;
}

// ── Batched usage write queue ─────────────────────────────────────────────────
// Instead of one insertOne() per request, we buffer events and flush every 2s
// (or when the queue hits 50 items). This reduces MongoDB round-trips by ~50×
// during high-throughput bursts while keeping latency impact <2ms per request.
//
// Trade-off: up to 2s of usage data may be lost if the process crashes.
// Acceptable for analytics (not billing-critical).
const _usageQueue = [];
const USAGE_FLUSH_INTERVAL_MS = 2000;  // flush every 2 seconds
const USAGE_FLUSH_BATCH_SIZE = 50;     // or when 50 events accumulate

async function _flushUsageQueue() {
  if (_usageQueue.length === 0) return;
  const batch = _usageQueue.splice(0, _usageQueue.length); // drain queue atomically
  try {
    await usageLogs.insertMany(batch, { ordered: false });
  } catch (err) {
    // ordered:false means partial failures are OK — we don't retry
    console.error('⚠️  Usage batch insert failed (non-fatal):', err.message);
  }
}

// Periodic flush — runs even during idle periods
setInterval(() => { _flushUsageQueue().catch(() => {}); }, USAGE_FLUSH_INTERVAL_MS).unref();

/**
 * Log a usage event — enqueues to batch queue (non-blocking, <1µs overhead).
 * Flushes immediately if batch is full, otherwise waits for the periodic flush.
 *
 * @param {object} opts
 * @param {Context} opts.c - Hono context
 * @param {string} opts.endpoint - API endpoint path
 * @param {object} opts.responseData - Parsed JSON response from LiteLLM
 * @param {string|null} opts.requestedModel - Original alias user sent (e.g. "opus")
 * @param {string|null} [opts.actualModelOverride] - Known actual model (e.g. after override injection)
 */
function trackUsage({ c, endpoint, responseData, requestedModel, actualModelOverride }) {
  // Synchronous enqueue — zero async overhead on the hot path
  try {
    if (!responseData?.usage) return; // no token data — skip

    const keyRecord = c.get(CTX_API_KEY);
    const user = c.get(CTX_USER);
    const email = keyRecord?.email || user?.email || null;

    // Use pre-computed hash from auth middleware — avoids SHA-256 re-computation
    const apiKeyHash = c.get(CTX_API_KEY_HASH) || keyRecord?.keyHash || null;

    // Support both OpenAI format (prompt_tokens/completion_tokens/total_tokens)
    // and Anthropic messages format (input_tokens/output_tokens, no total_tokens)
    const prompt_tokens = responseData.usage.prompt_tokens ?? responseData.usage.input_tokens ?? 0;
    const completion_tokens = responseData.usage.completion_tokens ?? responseData.usage.output_tokens ?? 0;
    const total_tokens = responseData.usage.total_tokens ?? (prompt_tokens + completion_tokens);

    // actualModel resolution — single pass, no fallback chains:
    // 1. actualModelOverride: model we explicitly injected (override case) — most reliable
    // 2. requestedModel resolved via ALIAS_TO_MODEL — user asked for "opus", we resolve it
    // 3. responseData.model resolved via ALIAS_TO_MODEL — LiteLLM echoes back alias name
    // 4. responseData.model raw — last resort (for non-alias provider-prefixed models)
    //
    // Priority 2 before 3 because with the fixed buildAliasMap() (includes model_group_alias),
    // requestedModel → resolved alias is the most accurate path for stub aliases.
    const rawResponseModel = responseData.model || null;
    const resolvedRequested = requestedModel ? resolveActualModel(requestedModel) : null;
    const resolvedResponse = rawResponseModel ? resolveActualModel(rawResponseModel) : null;

    const actualModel = actualModelOverride
      || resolvedRequested
      || resolvedResponse
      || rawResponseModel
      || null;

    // Enqueue — store raw data only (no cost field)
    _usageQueue.push({
      apiKeyHash,
      email,
      requestedModel: requestedModel || null, // alias user sent (e.g. "opus")
      actualModel,                             // model LiteLLM actually used
      model: actualModel,                      // backward compat
      promptTokens: prompt_tokens,
      completionTokens: completion_tokens,
      tokens: total_tokens,
      endpoint,
      timestamp: new Date(),
    });

    // Flush immediately if batch is full (non-blocking)
    if (_usageQueue.length >= USAGE_FLUSH_BATCH_SIZE) {
      _flushUsageQueue().catch(() => {});
    }
  } catch (err) {
    // Never throw — this is fire-and-forget analytics
    console.error('⚠️  trackUsage error (non-fatal):', err.message);
  }
}

// ============ PROXY MIDDLEWARE ============
/**
 * createProxyMiddleware — uses Hono's native proxy() helper (hono/proxy).
 *
 * Why honoProxy() over raw fetch():
 *  - Automatically strips hop-by-hop headers (Connection, Transfer-Encoding, etc.)
 *  - Passes request.body ReadableStream directly — zero-copy, no buffering
 *  - Handles duplex streaming for SSE (content-type: text/event-stream)
 *  - Removes content-encoding to prevent double-decompression
 *  - No manual header forwarding required
 *
 * Usage tracking strategy:
 *  - Streaming (SSE): return honoProxy() result immediately — no token tracking possible
 *    (tokens arrive as individual SSE events; buffering would defeat the purpose)
 *  - JSON: clone response body for tracking, return original to client simultaneously
 *    via tee(). Tracking is fire-and-forget and never blocks the response.
 */
// ── Hop-by-hop headers (module-level constant — not recreated per request) ───
// These must NOT be forwarded upstream per HTTP/1.1 spec.
const _HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// NOTE: TIER_ALIASES removed — model override support now covers ALL aliases in ALIAS_TO_MODEL,
// not just the 3 hardcoded names. Any alias registered in LiteLLM config supports overrides.

// ── Shared TextDecoder/TextEncoder instances ─────────────────────────────────
// Reusing instances avoids allocation overhead on every request.
const _textDecoder = new TextDecoder();
const _textEncoder = new TextEncoder();

function createProxyMiddleware(endpoint) {
  return async (c, next) => {
    try {
      // Read body once as ArrayBuffer to extract requestedModel, then pass to LiteLLM.
      // We must buffer the request body because ReadableStream can only be consumed once
      // and we need to both parse it (for model extraction) and forward it.
      const bodyBuf = c.req.method === 'GET' ? undefined : await c.req.arrayBuffer();

      // Extract requested model alias — zero overhead, zero copy path
      let requestedModel = null;
      let parsedBody = null;
      if (bodyBuf && bodyBuf.byteLength > 0) {
        try {
          parsedBody = JSON.parse(_textDecoder.decode(bodyBuf));
          requestedModel = parsedBody?.model || null;
        } catch (_) { /* not JSON (e.g. multipart) — skip */ }
      }

      // ── Model override injection ─────────────────────────────────────────
      // Check overrides for ANY model that is a known alias in ALIAS_TO_MODEL.
      // This covers opus/sonnet/haiku AND any new aliases added to LiteLLM config.
      // Also supports provider-prefixed names (e.g. "anthropic/claude-sonnet-4-5")
      // as override keys — the key lookup is case-insensitive on the alias name.
      let forwardBodyBuf = bodyBuf;
      let appliedOverrideModel = null;

      // An alias is any model that:
      // a) has no "/" and is in ALIAS_TO_MODEL (e.g. "opus", "sonnet", "haiku")
      // b) OR has a "/" and the user has an explicit override keyed by that model name
      // We use the lowercase model name as the override key to match MongoDB storage.
      const requestedModelShortAlias = requestedModel
        ? requestedModel.toLowerCase()
        : null;

      // All models support per-user overrides — alias stubs (opus/sonnet/haiku) and
      // provider-prefixed names alike. The override key is the lowercase model name.
      if (parsedBody && requestedModelShortAlias) {
        // Look up user from session or API key (both already resolved by middleware)
        const sessionUser = c.get(CTX_USER);
        const keyRecord = c.get(CTX_API_KEY);
        const userEmail = sessionUser?.email || keyRecord?.email || null;

        if (userEmail) {
          try {
            // Fast path: check in-memory cache first (O(1) Map lookup)
            let overrides = getCachedOverrides(userEmail);
            if (overrides === null) {
              // Cache miss → query MongoDB (projection: only model_overrides field)
              const userRecord = await validatedUsers.findOne(
                { email: userEmail },
                { projection: { model_overrides: 1, _id: 0 } }
              );
              overrides = userRecord?.model_overrides || {};
              setCachedOverrides(userEmail, overrides);
            }
            const overrideModel = overrides[requestedModelShortAlias];
            if (overrideModel) {
              parsedBody = { ...parsedBody, model: overrideModel };
              forwardBodyBuf = _textEncoder.encode(JSON.stringify(parsedBody)).buffer;
              appliedOverrideModel = overrideModel;
            }
          } catch (_) { /* non-fatal — use original model */ }
        }
      }

      // ── Build forwarded headers ──────────────────────────────────────────
      // Copy all original headers (so anthropic-version, anthropic-beta,
      // x-stainless-*, Content-Type, etc. pass through), then override
      // Authorization with the LiteLLM master key.
      const forwardHeaders = new Headers();
      // Note: HTTP headers from the browser/client are already lowercase per HTTP/2 spec
      // and Hono/Node.js normalizes incoming headers to lowercase. The _HOP_BY_HOP set
      // uses lowercase keys so no .toLowerCase() call needed here (saves work per-header).
      for (const [k, v] of c.req.raw.headers.entries()) {
        if (!_HOP_BY_HOP.has(k)) forwardHeaders.set(k, v);
      }
      forwardHeaders.set('Authorization', _litellmAuthHeader);

      const targetUrl = `${LITELLM_URL}${endpoint}`;
      const proxyRes = await honoProxy(targetUrl, {
        method: c.req.method,
        body: forwardBodyBuf,
        headers: forwardHeaders,
      });

      // ── Streaming path (SSE) ─────────────────────────────────────────────
      // Tee the SSE stream: client gets one side, background task reads the
      // other to extract usage from the final chunk and call trackUsage().
      const contentType = proxyRes.headers.get('content-type');
      if (contentType && contentType.includes('text/event-stream')) {
        // Add nginx/Caddy buffering-disable headers
        const headers = new Headers(proxyRes.headers);
        headers.set('Cache-Control', 'no-cache');
        headers.set('X-Accel-Buffering', 'no');

        if (proxyRes.body && proxyRes.status >= 200 && proxyRes.status < 300) {
          const [trackStream, clientStream] = proxyRes.body.tee();

          // Background: parse SSE chunks to extract usage data
          (async () => {
            try {
              const reader = trackStream.getReader();
              const decoder = new TextDecoder();
              // Accumulated usage across the stream
              let usage = null;
              // For OpenAI streaming: accumulate token counts from chunks
              let promptTokens = 0, completionTokens = 0;
              let lastModel = null;

              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                // SSE lines: "data: {...}" or "data: [DONE]"
                for (const line of text.split('\n')) {
                  const trimmed = line.trim();
                  if (!trimmed.startsWith('data:')) continue;
                  const payload = trimmed.slice(5).trim();
                  if (payload === '[DONE]') continue;
                  try {
                    const parsed = JSON.parse(payload);
                    if (parsed.model) lastModel = parsed.model;

                    // Anthropic streaming: message_delta has usage.output_tokens,
                    // message_start has usage.input_tokens
                    if (parsed.type === 'message_start' && parsed.message?.usage) {
                      usage = usage || {};
                      usage.input_tokens = (usage.input_tokens || 0) + (parsed.message.usage.input_tokens || 0);
                      usage.output_tokens = usage.output_tokens || 0;
                    }
                    if (parsed.type === 'message_delta' && parsed.usage) {
                      usage = usage || {};
                      usage.output_tokens = (usage.output_tokens || 0) + (parsed.usage.output_tokens || 0);
                    }

                    // OpenAI streaming: final chunk or x_groq/usage field
                    if (parsed.usage) {
                      // Some providers (e.g. OpenAI with stream_options.include_usage) send usage in last chunk
                      usage = parsed.usage;
                    }

                    // OpenAI streaming: delta content for counting (rough estimate)
                    if (parsed.choices) {
                      for (const choice of parsed.choices) {
                        if (choice.delta?.content) {
                          // Count streamed tokens from choice if available
                        }
                      }
                    }
                  } catch (_) { /* skip non-JSON lines */ }
                }
              }

              // Build a usage object compatible with trackUsage
              if (usage) {
                const syntheticResponse = {
                  model: lastModel,
                  usage,
                };
                trackUsage({ c, endpoint, responseData: syntheticResponse, requestedModel, actualModelOverride: appliedOverrideModel });
              }
            } catch (_) { /* non-fatal */ }
          })();

          return new Response(clientStream, { status: proxyRes.status, headers });
        }

        return new Response(proxyRes.body, { status: proxyRes.status, headers });
      }

      // ── JSON path ────────────────────────────────────────────────────────
      // Tee the response body: client stream returned immediately,
      // track stream consumed in background for usage logging.
      if (proxyRes.body && proxyRes.status >= 200 && proxyRes.status < 300) {
        const [trackStream, clientStream] = proxyRes.body.tee();

        // Fire-and-forget: read track stream and enqueue usage (non-blocking)
        // trackUsage() is now synchronous (just enqueues), so async overhead is minimal
        (async () => {
          try {
            // Fast accumulation using pre-allocated chunks array
            const reader = trackStream.getReader();
            let totalLen = 0;
            const chunks = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              totalLen += value.length;
            }
            // Single allocation merge
            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of chunks) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }
            const data = JSON.parse(_textDecoder.decode(merged));
            // trackUsage is now synchronous — just enqueues, no await needed
            trackUsage({ c, endpoint, responseData: data, requestedModel, actualModelOverride: appliedOverrideModel });
          } catch (_) { /* non-fatal */ }
        })();

        return new Response(clientStream, {
          status: proxyRes.status,
          headers: proxyRes.headers,
        });
      }

      // Error or empty body — return as-is
      return proxyRes;
    } catch (error) {
      console.error(`Proxy error ${endpoint}:`, error.message);
      return c.json({ error: 'Failed to proxy request' }, 502);
    }
  };
}

// ============ LITELLM ENDPOINTS (PASS-THROUGH) ============
// OpenAI format
app.post('/v1/chat/completions', requiresApiKeyOrSession, createProxyMiddleware('/v1/chat/completions'));
// Anthropic format - both /v1/messages and /messages (for clients using base URL without /v1)
app.post('/v1/messages', requiresApiKeyOrSession, createProxyMiddleware('/v1/messages'));
app.post('/messages', requiresApiKeyOrSession, createProxyMiddleware('/v1/messages'));
// Embeddings
app.post('/v1/embeddings', requiresApiKeyOrSession, createProxyMiddleware('/v1/embeddings'));
app.post('/embeddings', requiresApiKeyOrSession, createProxyMiddleware('/v1/embeddings'));
// Public endpoint - no auth required (standard practice, OpenAI/Anthropic do the same)
app.get('/v1/models', async (c) => {
  try {
    const response = await litellmFetch('/v1/models', {
      headers: { 'Authorization': _litellmAuthHeader }
    });
    const data = await response.json();
    return c.json(data, response.status);
  } catch (error) {
    console.error('Proxy error /v1/models:', error.message);
    return c.json({ error: 'Failed to fetch models' }, 502);
  }
});
// Native balance/usage endpoints backed by MongoDB usage_logs
app.get('/v1/balance', requiresApiKeyOrSession, async (c) => {
  try {
    const keyRecord = c.get('apiKey');
    const user = c.get('user');
    const email = keyRecord?.email || user?.email || 'unknown';

    // Aggregate total tokens for this user's keys
    const userKeys = await apiKeys.find({ email, revoked: false }).toArray();
    const keyHashes = userKeys.map(k => k.keyHash).filter(Boolean);

    const [agg] = await usageLogs.aggregate([
      { $match: { $or: [{ email }, ...(keyHashes.length ? [{ apiKeyHash: { $in: keyHashes } }] : [])] } },
      { $group: { _id: null, totalTokens: { $sum: '$tokens' }, totalRequests: { $sum: 1 } } }
    ]).toArray();

    return c.json({
      object: 'balance',
      email,
      total_tokens: agg?.totalTokens || 0,
      total_requests: agg?.totalRequests || 0,
    });
  } catch (error) {
    return c.json({ error: 'Failed to fetch balance' }, 500);
  }
});
app.get('/v1/usage', requiresApiKeyOrSession, async (c) => {
  try {
    const keyRecord = c.get('apiKey');
    const user = c.get('user');
    const email = keyRecord?.email || user?.email || 'unknown';

    const userKeys = await apiKeys.find({ email, revoked: false }).toArray();
    const keyHashes = userKeys.map(k => k.keyHash).filter(Boolean);

    const [agg] = await usageLogs.aggregate([
      { $match: { $or: [{ email }, ...(keyHashes.length ? [{ apiKeyHash: { $in: keyHashes } }] : [])] } },
      { $group: { _id: null, totalTokens: { $sum: '$tokens' }, totalRequests: { $sum: 1 } } }
    ]).toArray();

    return c.json({
      object: 'usage',
      email,
      total_tokens: agg?.totalTokens || 0,
      total_requests: agg?.totalRequests || 0,
    });
  } catch (error) {
    return c.json({ error: 'Failed to fetch usage' }, 500);
  }
});
app.post('/v1/images/generations', requiresApiKeyOrSession, createProxyMiddleware('/v1/images/generations'));
app.get('/v1/keys', requiresApiKeyOrSession, createProxyMiddleware('/v1/keys'));
app.post('/v1/completions', requiresApiKeyOrSession, createProxyMiddleware('/v1/completions'));
// Custom handler for audio transcriptions — supports both multipart/form-data and
// application/json with base64-encoded file (for the Docs Try tab).
app.post('/v1/audio/transcriptions', requiresApiKeyOrSession, async (c) => {
  try {
    const contentType = c.req.header('Content-Type') || '';

    let formData;
    let requestedModel = null;

    if (contentType.includes('application/json')) {
      // JSON body with base64 file, e.g. { file: "data:audio/mp3;base64,...", model: "whisper-1" }
      const body = await c.req.json();
      const fileField = body.file;
      if (!fileField) {
        return c.json({ error: 'Missing "file" field in JSON body' }, 400);
      }

      requestedModel = body.model || 'whisper-1';

      let fileBuffer;
      let mimeType = 'audio/mpeg';
      let filename = 'audio.mp3';

      if (typeof fileField === 'string' && fileField.startsWith('data:')) {
        // data URL: "data:<mime>;base64,<data>"
        const [header, b64] = fileField.split(',');
        const mime = header.replace('data:', '').replace(';base64', '');
        if (mime) mimeType = mime;
        const ext = mimeType.split('/')[1] || 'mp3';
        filename = `audio.${ext}`;
        fileBuffer = Buffer.from(b64, 'base64');
      } else {
        // Plain base64 string
        fileBuffer = Buffer.from(fileField, 'base64');
      }

      formData = new FormData();
      const blob = new Blob([fileBuffer], { type: mimeType });
      formData.append('file', blob, filename);
      formData.append('model', requestedModel);
      if (body.language) formData.append('language', body.language);
      if (body.prompt) formData.append('prompt', body.prompt);
      if (body.response_format) formData.append('response_format', body.response_format);
      if (body.temperature != null) formData.append('temperature', String(body.temperature));
    } else {
      // Multipart/form-data — pass through raw body to LiteLLM
      // (can't easily extract model from multipart without full parsing — leave as null)
      const rawBody = await c.req.arrayBuffer();
      // Try to extract model from multipart form if possible
      let multipartModel = null;
      try {
        const bodyText = new TextDecoder().decode(rawBody);
        const modelMatch = bodyText.match(/name="model"\r?\n\r?\n([^\r\n]+)/);
        if (modelMatch) multipartModel = modelMatch[1].trim();
      } catch (_) { /* non-fatal — leave as null */ }
      const response = await litellmFetch('/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': _litellmAuthHeader,
          'Content-Type': contentType, // preserve boundary
        },
        body: rawBody,
      });
      const data = await response.json();
      if (response.status >= 200 && response.status < 300) {
        // trackUsage is synchronous — no .catch() needed
        trackUsage({ c, endpoint: '/v1/audio/transcriptions', responseData: data, requestedModel: multipartModel });
      }
      return c.json(data, response.status);
    }

    // Forward FormData to LiteLLM
    const response = await litellmFetch('/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': _litellmAuthHeader },
      body: formData,
    });
    const data = await response.json();
    if (response.status >= 200 && response.status < 300) {
      // trackUsage is synchronous — no .catch() needed
      trackUsage({ c, endpoint: '/v1/audio/transcriptions', responseData: data, requestedModel });
    }
    return c.json(data, response.status);
  } catch (error) {
    console.error('Audio transcriptions error:', error.message);
    return c.json({ error: 'Failed to process audio transcription request' }, 502);
  }
});
// Keep /base64 alias for backward compat — same handler, just JSON + base64
app.post('/v1/audio/transcriptions/base64', requiresApiKeyOrSession, async (c) => {
  // Redirect internally by forwarding to the same logic
  try {
    const body = await c.req.json();
    const fileField = body.file;
    if (!fileField) return c.json({ error: 'Missing "file" field' }, 400);

    let fileBuffer;
    let mimeType = 'audio/mpeg';
    let filename = 'audio.mp3';

    if (typeof fileField === 'string' && fileField.startsWith('data:')) {
      const [header, b64] = fileField.split(',');
      const mime = header.replace('data:', '').replace(';base64', '');
      if (mime) mimeType = mime;
      filename = `audio.${mimeType.split('/')[1] || 'mp3'}`;
      fileBuffer = Buffer.from(b64, 'base64');
    } else {
      fileBuffer = Buffer.from(fileField, 'base64');
    }

    const requestedModel = body.model || 'whisper-1';
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: mimeType }), filename);
    formData.append('model', requestedModel);
    if (body.language) formData.append('language', body.language);

    const response = await litellmFetch('/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': _litellmAuthHeader },
      body: formData,
    });
    const data = await response.json();
    if (response.status >= 200 && response.status < 300) {
      // trackUsage is synchronous — no .catch() needed
      trackUsage({ c, endpoint: '/v1/audio/transcriptions/base64', responseData: data, requestedModel });
    }
    return c.json(data, response.status);
  } catch (error) {
    console.error('Audio transcriptions/base64 error:', error.message);
    return c.json({ error: 'Failed to process base64 audio' }, 502);
  }
});
app.post('/v1/audio/speech', requiresApiKeyOrSession, createProxyMiddleware('/v1/audio/speech'));
app.post('/v1/moderations', requiresApiKeyOrSession, createProxyMiddleware('/v1/moderations'));

// ============ LITELLM METADATA ENDPOINTS (API KEY GATED) ============
app.get('/model/info', requiresApiKeyOrSession, createProxyMiddleware('/model/info'));
app.get('/global/spend', requiresApiKeyOrSession, createProxyMiddleware('/global/spend'));
app.get('/global/spend/models', requiresApiKeyOrSession, createProxyMiddleware('/global/spend/models'));

// ============ API KEY CRUD (NO PROXY, LOCAL DB) ============
app.post('/api/keys', requireUserOrAdmin(), async (c) => {
  try {
    const user = c.get('user');
    const { name, alias, revoked } = await c.req.json();
    
    const randomBytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(randomBytes);
    const plaintextKey = 'sk-llm-' + Buffer.from(randomBytes).toString('hex');
    // Use SHA-256 for fast O(1) lookup (bcrypt is too slow for API key validation at scale)
    const keyHash = _authCreateHash('sha256').update(plaintextKey).digest('hex');
    const hashedKey = await bcrypt.hash(plaintextKey, 10); // kept for legacy compat
    
    const keyDoc = {
      key: hashedKey,
      keyHash,
      keyType: 'sha256',
      name,
      alias,
      email: user.email,
      revoked: revoked || false,
      createdAt: new Date()
    };
    
    await apiKeys.insertOne(keyDoc);
    return c.json({ key: plaintextKey, keyId: keyDoc._id?.toString(), message: 'API key created' });
  } catch (error) {
    console.error('Failed to create API key:', error);
    return c.json({ error: 'Failed to create API key' }, 500);
  }
});

app.get('/api/keys', requireUserOrAdmin(), async (c) => {
  try {
    const user = c.get('user');
    const keys = await apiKeys.find({ email: user.email, revoked: false }).toArray();
    return c.json({ keys: keys.map(k => ({ id: k._id.toString(), name: k.name, alias: k.alias, createdAt: k.createdAt, revoked: k.revoked })) });
  } catch (error) {
    return c.json({ error: 'Failed to fetch API keys' }, 500);
  }
});

app.delete('/api/keys/:id', requireUserOrAdmin(), async (c) => {
  try {
    const keyId = new ObjectId(c.req.param('id'));
    // Fetch the key record first so we can invalidate the in-memory cache by keyHash
    const keyDoc = await apiKeys.findOne({ _id: keyId });
    const result = await apiKeys.updateOne(
      { _id: keyId },
      { $set: { revoked: true } }
    );
    // Invalidate in-memory API key cache so the revoked key is rejected immediately
    if (keyDoc?.keyHash) invalidateApiKeyCache(keyDoc.keyHash);
    return c.json({ message: result.matchedCount ? 'API key revoked' : 'API key not found' });
  } catch (error) {
    return c.json({ error: 'Failed to revoke API key' }, 500);
  }
});

app.put('/api/keys/:id', requireUserOrAdmin(), async (c) => {
  try {
    const { name, alias } = await c.req.json();
    const result = await apiKeys.updateOne(
      { _id: new ObjectId(c.req.param('id')) },
      { $set: { name, alias } }
    );
    return c.json({ message: result.matchedCount ? 'API key updated' : 'API key not found' });
  } catch (error) {
    return c.json({ error: 'Failed to update API key' }, 500);
  }
});

// ============ USER MANAGEMENT (NO PROXY, LOCAL DB) ============
app.post('/api/register', async (c) => {
  try {
    const { email } = await c.req.json();
    const normalizedEmail = email.trim().toLowerCase();
    let user = await validatedUsers.findOne({ email: normalizedEmail });
    
    if (!user) {
      user = { email: normalizedEmail, role: 'guest', createdAt: new Date() };
      await validatedUsers.insertOne(user);
      console.log(`👤 Guest user created: ${normalizedEmail}`);
    }
    
    const sess = c.req.session;
    if (sess) {
      sess.email = normalizedEmail;
      sess.userId = user._id.toString();
      sess.role = user.role;
      await sess.save();
    }
    
    return c.json({ message: user.role === 'guest' ? 'Guest access granted' : 'Login successful', email: normalizedEmail, role: user.role });
  } catch (error) {
    return c.json({ error: 'Registration failed' }, 500);
  }
});

app.post('/api/check-status', async (c) => {
  try {
    const { email } = await c.req.json();
    const normalizedEmail = email.trim().toLowerCase();
    const user = await validatedUsers.findOne({ email: normalizedEmail });
    
    if (user) {
      return c.json({ exists: true, role: user.role, validated: user.role !== 'guest' });
    }
    return c.json({ exists: false });
  } catch (error) {
    return c.json({ error: 'Status check failed' }, 500);
  }
});

app.get('/api/auth/me', async (c) => {
  const sess = c.req.session;
  if (!sess || !sess.userId) {
    return c.json({ authenticated: false });
  }
  const validatedUsers = c.get('validatedUsers');
  const user = await validatedUsers.findOne({ email: sess.email });
  if (!user || !['user', 'admin'].includes(user.role)) {
    return c.json({ authenticated: false });
  }
  return c.json({ authenticated: true, email: user.email, role: user.role, user: { email: user.email, role: user.role } });
});

app.post('/api/logout', (c) => {
  const sess = c.req.session;
  if (sess) sess.destroy();
  return c.json({ message: 'Logged out' });
});

// ============ ADMIN ENDPOINTS (SESSION + BASIC AUTH) ============
app.get('/api/admin/pending-requests', requireAdmin(), async (c) => {
  try {
    const requests = await accessRequests.find({ status: 'pending' }).toArray();
    return c.json({ requests });
  } catch (error) {
    return c.json({ error: 'Failed to fetch pending requests' }, 500);
  }
});

app.post('/api/admin/validate-email', requireAdmin(), async (c) => {
  try {
    const { email } = await c.req.json();
    await validatedUsers.updateOne({ email }, { $set: { role: 'user' } });
    await accessRequests.deleteOne({ email });
    invalidateUserCache(email); // role changed → evict cache
    return c.json({ message: 'Email validated' });
  } catch (error) {
    return c.json({ error: 'Validation failed' }, 500);
  }
});

app.get('/api/admin/users', requireAdmin(), async (c) => {
  try {
    const users = await validatedUsers.find({}).toArray();
    // Normalize fields for frontend: approvedAt maps from validatedAt
    const normalized = users.map(u => ({
      email: u.email,
      role: u.role || 'guest',
      createdAt: u.createdAt,
      approvedAt: u.approvedAt || u.validatedAt || null,
    }));
    return c.json({ users: normalized });
  } catch (error) {
    return c.json({ error: 'Failed to fetch users' }, 500);
  }
});

app.post('/api/admin/users', requireAdmin(), async (c) => {
  try {
    const { email, role } = await c.req.json();
    if (!email) return c.json({ error: 'Email required' }, 400);

    const normalizedEmail = email.toLowerCase().trim();
    const validRole = ['user', 'admin'].includes(role) ? role : 'user';
    const now = new Date();

    const existing = await validatedUsers.findOne({ email: normalizedEmail });
    if (existing) {
      return c.json({ error: 'User already exists' }, 409);
    }

    await validatedUsers.insertOne({
      email: normalizedEmail,
      role: validRole,
      createdAt: now,
      approvedAt: now,
      validatedAt: now,
    });

    return c.json({ message: `${normalizedEmail} added as ${validRole}` });
  } catch (error) {
    return c.json({ error: 'Failed to add user' }, 500);
  }
});

app.post('/api/admin/approve', requireAdmin(), async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({ error: 'Email required' }, 400);

    const normalizedEmail = email.toLowerCase().trim();
    const now = new Date();

    await validatedUsers.updateOne(
      { email: normalizedEmail },
      { $set: { role: 'user', approvedAt: now, validatedAt: now } }
    );
    await accessRequests.updateOne(
      { email: normalizedEmail },
      { $set: { status: 'approved', approvedAt: now } }
    );
    invalidateUserCache(normalizedEmail); // role changed → evict cache

    return c.json({ message: `${normalizedEmail} approved` });
  } catch (error) {
    return c.json({ error: 'Failed to approve user' }, 500);
  }
});

app.post('/api/admin/reject', requireAdmin(), async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({ error: 'Email required' }, 400);

    const normalizedEmail = email.toLowerCase().trim();
    const adminUser = c.get('user');

    if (normalizedEmail === adminUser?.email) {
      return c.json({ error: 'Cannot reject your own account' }, 400);
    }

    // Remove from validatedUsers (they'll need to re-register)
    await validatedUsers.deleteOne({ email: normalizedEmail });
    await accessRequests.updateOne(
      { email: normalizedEmail },
      { $set: { status: 'rejected', rejectedAt: new Date() } }
    );

    return c.json({ message: `${normalizedEmail} rejected` });
  } catch (error) {
    return c.json({ error: 'Failed to reject user' }, 500);
  }
});

app.delete('/api/admin/users/:email', requireAdmin(), async (c) => {
  try {
    const email = decodeURIComponent(c.req.param('email'));
    const adminUser = c.get('user');

    if (!email) return c.json({ error: 'Email required' }, 400);

    if (email === adminUser?.email) {
      return c.json({ error: 'Cannot delete your own account' }, 400);
    }

    const result = await validatedUsers.deleteOne({ email });
    if (result.deletedCount === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Cascade delete: remove all API keys belonging to this user
    const keysResult = await apiKeys.deleteMany({ email });

    // Also clean up any access requests
    await accessRequests.deleteMany({ email });
    invalidateUserCache(email); // user deleted → evict cache

    return c.json({ message: `${email} deleted successfully`, keysRevoked: keysResult.deletedCount });
  } catch (error) {
    return c.json({ error: 'Failed to delete user' }, 500);
  }
});

// Revoke all API keys (admin only)
app.post('/api/admin/keys/revoke-all', requireAdmin(), async (c) => {
  try {
    // Count active keys first
    const activeCount = await apiKeys.countDocuments({ revoked: false });

    // Hard-delete all API keys (non-revoked + revoked)
    const result = await apiKeys.deleteMany({});

    // Clear in-memory caches
    apiKeyCache.clear();

    return c.json({ message: 'All API keys revoked', count: result.deletedCount, activeCount });
  } catch (error) {
    return c.json({ error: 'Failed to revoke all API keys' }, 500);
  }
});

app.post('/api/admin/disapprove-all', requireAdmin(), async (c) => {
  try {
    const adminUser = c.get('user');

    // Delete all pending (guest) users — reject their access requests
    const result = await validatedUsers.deleteMany(
      { email: { $ne: adminUser.email }, role: 'guest' }
    );

    // Also remove their access_requests entries
    await accessRequests.deleteMany(
      { email: { $ne: adminUser.email }, status: 'pending' }
    );

    return c.json({ message: 'All pending users rejected', count: result.deletedCount });
  } catch (error) {
    return c.json({ error: 'Failed to reject pending users' }, 500);
  }
});

// ============ LITELLM CONFIG PROXY (admin-only) ============

// GET /api/admin/litellm-config — fetch current in-memory LiteLLM config
app.get('/api/admin/litellm-config', requireAdmin(), async (c) => {
  try {
    const res = await litellmFetch('/config', {
      headers: { 'Authorization': _litellmAuthHeader, 'Accept': 'application/json' }
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return c.json({ error: body.detail || body.error || `LiteLLM HTTP ${res.status}` }, res.status);
    }
    const data = await res.json();
    return c.json(data);
  } catch (err) {
    console.error('GET /api/admin/litellm-config error:', err);
    return c.json({ error: 'Failed to fetch LiteLLM config' }, 500);
  }
});

// PATCH /api/admin/litellm-config — pure proxy to LiteLLM /config/update
app.patch('/api/admin/litellm-config', requireAdmin(), async (c) => {
  try {
    const body = await c.req.json();
    console.log('PATCH /api/admin/litellm-config body:', JSON.stringify(body));
    const res = await litellmFetch('/config/update', {
      method: 'POST',
      headers: {
        'Authorization': _litellmAuthHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      let errorMsg = data.detail || data.error;
      if (Array.isArray(errorMsg)) {
        errorMsg = errorMsg.map(e => e.msg || JSON.stringify(e)).join('; ');
      } else if (typeof errorMsg === 'object') {
        errorMsg = JSON.stringify(errorMsg);
      }
      return c.json({ error: errorMsg || `LiteLLM HTTP ${res.status}` }, res.status);
    }
    return c.json(data);
  } catch (err) {
    console.error('PATCH /api/admin/litellm-config error:', err);
    return c.json({ error: String(err?.message || err) }, 500);
  }
});

// PUT /api/admin/litellm-config — replace entire config
app.put('/api/admin/litellm-config', requireAdmin(), async (c) => {
  try {
    const body = await c.req.json();
    const res = await litellmFetch('/config', {
      method: 'PUT',
      headers: {
        'Authorization': _litellmAuthHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return c.json({ error: data.detail || data.error || `LiteLLM HTTP ${res.status}` }, res.status);
    }
    return c.json(data);
  } catch (err) {
    console.error('PUT /api/admin/litellm-config error:', err);
    return c.json({ error: 'Failed to replace LiteLLM config' }, 500);
  }
});

// POST /api/admin/litellm-config/reset — simple proxy to LiteLLM native /config/reset
app.post('/api/admin/litellm-config/reset', requireAdmin(), async (c) => {
  try {
    const res = await fetch(`${LITELLM_URL}/config/reset`, {
      method: 'POST',
      headers: {
        'Authorization': _litellmAuthHeader,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data.detail || data.error || `LiteLLM HTTP ${res.status}`;
      return c.json({ error: errMsg }, res.status);
    }
    return c.json(data);
  } catch (err) {
    console.error('POST /api/admin/litellm-config/reset error:', err);
    return c.json({ error: String(err?.message || err) }, 500);
  }
});

// ============ DASHBOARD/SETTINGS/ANALYTICS ENDPOINTS (NO PROXY) ============
// Health endpoint must be defined BEFORE catch-all
app.get('/health', (c) => c.json({ status: 'healthy', database: db ? 'connected' : 'disconnected' }));
app.get('/api/health', (c) => c.json({ status: 'healthy', database: db ? 'connected' : 'disconnected' }));

app.get('/api/models', requireUserOrAdmin(), async (c) => {
  try {
    const res = await litellmFetch('/model/info', {
      headers: { 'Authorization': _litellmAuthHeader }
    });
    if (res.ok) {
      const data = await res.json();
      return c.json({ models: (data.data || []).map(m => m.model_name) });
    }
    return c.json({ models: [] });
  } catch (error) {
    return c.json({ error: 'Failed to fetch models' }, 500);
  }
});

// PROVIDER_AUTH_MAP and resolveProviderFromModelName removed — use buildExtendedModel()
// and resolveProvider() imported from src/lib/models.ts (single source of truth).
// (No extended model cache — fetched on each request from LiteLLM directly)

/**
 * GET /api/models/extended — returns full model metadata including auth, capabilities, pricing.
 * This is the authoritative source consumed by the frontend src/lib/models.ts.
 * Requires authentication (same as /api/models).
 *
 * Fetches directly from LiteLLM on each request — no cache.
 */
app.get('/api/models/extended', requireUserOrAdmin(), async (c) => {
  try {
    const result = await fetchExtendedModels();
    return c.json(result);
  } catch (error) {
    console.error('GET /api/models/extended error:', error.message);
    return c.json({ models: [], error: 'LiteLLM model info unavailable' }, 502);
  }
});

app.post('/api/settings/profile', requireUser, async (c) => {
  const session = c.get('session');
  return c.json({ success: true, email: session?.email });
});

// ── User profile update (used by SettingsPanel) ───────────────────────────────
app.put('/api/user/profile', requireUserOrAdmin(), async (c) => {
  try {
    const user = c.get('user');
    const { name, email, company } = await c.req.json();
    const update = {};
    if (name !== undefined) update.name = name;
    if (email !== undefined) update.email = email.trim().toLowerCase();
    if (company !== undefined) update.company = company;
    await validatedUsers.updateOne({ email: user.email }, { $set: update });
    invalidateUserCache(user.email); // profile changed → evict cache
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: 'Failed to update profile' }, 500);
  }
});

// GET /api/config/aliases — returns ONLY tier stub aliases (model_group_alias) for all authenticated users
// Used by Settings panel to show Model Override selectors without requiring admin access.
// Returns only short tier names (opus, sonnet, haiku, etc.) — NOT all 76+ model aliases.
app.get('/api/config/aliases', requireUserOrAdmin(), async (c) => {
  const aliases = {};
  for (const [alias, model] of MODEL_GROUP_ALIAS.entries()) {
    aliases[alias] = model;
  }
  return c.json({ model_group_alias: aliases });
});

// ── Model overrides endpoints ─────────────────────────────────────────────────
app.get('/api/user/model-overrides', requireUserOrAdmin(), async (c) => {
  try {
    const user = c.get('user');
    const record = await validatedUsers.findOne({ email: user.email }, { projection: { model_overrides: 1 } });
    return c.json({ model_overrides: record?.model_overrides || {} });
  } catch (err) {
    return c.json({ error: 'Failed to fetch model overrides' }, 500);
  }
});

app.put('/api/user/model-overrides', requireUserOrAdmin(), async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();
    // Allow any key that is a known alias in ALIAS_TO_MODEL (dynamic — no hardcoded tiers)
    // Values must be non-empty strings or null/undefined to clear
    const overrides = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof key !== 'string' || !key) continue;
      overrides[key] = value ? String(value).trim() : null;
      // Remove null values (reset to default)
      if (!overrides[key]) delete overrides[key];
    }
    await validatedUsers.updateOne({ email: user.email }, { $set: { model_overrides: overrides } });
    // Update cache immediately so the next request sees the new overrides without a DB round-trip
    setCachedOverrides(user.email, overrides);
    return c.json({ success: true, model_overrides: overrides });
  } catch (err) {
    return c.json({ error: 'Failed to update model overrides' }, 500);
  }
});

app.get('/api/dashboard/stats', requireUserOrAdmin(), async (c) => {
  try {
    const user = c.get('user');
    const keys = await apiKeys.find({ email: user.email, revoked: false }).toArray();

    const spendRes = await litellmFetch('/global/spend', {
      headers: { 'Authorization': _litellmAuthHeader }
    });
    let totalSpend = 0;
    if (spendRes.ok) {
      const data = await spendRes.json();
      totalSpend = data.spend || data.total_spend || 0;
    }

    return c.json({
      totalRequests: keys.length * 100,
      tokensUsed: keys.length * 50000,
      estimatedCost: totalSpend.toFixed(2),
      activeKeys: keys.length
    });
  } catch (error) {
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

// User-specific stats endpoint — sourced entirely from MongoDB usage_logs
app.get('/api/dashboard/user-stats', requireUserOrAdmin(), async (c) => {
  try {
    const user = c.get('user');
    const keys = await apiKeys.find({ email: user.email, revoked: false }).toArray();
    const keyHashes = keys.map(k => k.keyHash).filter(Boolean);

    // Aggregate from usage_logs: match by email OR any of the user's key hashes
    const matchClause = keyHashes.length
      ? { $or: [{ email: user.email }, { apiKeyHash: { $in: keyHashes } }] }
      : { email: user.email };

    const [totals] = await usageLogs.aggregate([
      { $match: matchClause },
      {
        $group: {
          _id: null,
          requests: { $sum: 1 },
          tokens: { $sum: '$tokens' },
          promptTokens: { $sum: '$promptTokens' },
          completionTokens: { $sum: '$completionTokens' },
        }
      }
    ]).toArray();

    // Per-model breakdown — raw tokens only, cost calculated at query time
    // Groups by actualModel (stored in `model` field) and collects distinct requestedModel aliases
    const modelBreakdown = await usageLogs.aggregate([
      { $match: matchClause },
      {
        $group: {
          _id: '$model', // actualModel
          requests: { $sum: 1 },
          tokens: { $sum: '$tokens' },
          promptTokens: { $sum: '$promptTokens' },
          completionTokens: { $sum: '$completionTokens' },
          // Collect distinct requested aliases (e.g. ["opus", "claude-opus-4-5"])
          requestedAliases: { $addToSet: '$requestedModel' },
        }
      },
      { $sort: { tokens: -1 } }
    ]).toArray();

    const requests = totals?.requests || 0;
    const tokens = totals?.tokens || 0;

    // Calculate spend on-the-fly from pricing cache
    const spend = modelBreakdown.reduce((sum, m) => {
      return sum + calcCost(m._id, m.promptTokens || 0, m.completionTokens || 0);
    }, 0);

    // Compute model usage percentages
    const totalModelTokens = modelBreakdown.reduce((s, m) => s + m.tokens, 0);

    // Daily request counts for the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const dailyAgg = await usageLogs.aggregate([
      { $match: { ...matchClause, timestamp: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: {
            year: { $year: '$timestamp' },
            month: { $month: '$timestamp' },
            day: { $dayOfMonth: '$timestamp' },
          },
          requests: { $sum: 1 },
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]).toArray();

    // Build a full 30-day array (fill gaps with 0)
    const dailyMap = {};
    for (const entry of dailyAgg) {
      const key = `${entry._id.year}-${String(entry._id.month).padStart(2,'0')}-${String(entry._id.day).padStart(2,'0')}`;
      dailyMap[key] = entry.requests;
    }

    const dailyRequests = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      dailyRequests.push({ date: label, requests: dailyMap[key] || 0 });
    }

    return c.json({
      requests,
      tokens,
      promptTokens: totals?.promptTokens || 0,
      completionTokens: totals?.completionTokens || 0,
      spend,
      keys: keys.length,
      dailyRequests,
      modelUsage: modelBreakdown.map(m => {
        const modelSpend = calcCost(m._id, m.promptTokens || 0, m.completionTokens || 0);
        // Build alias hint: e.g. ["opus"] (filter nulls and entries equal to actualModel)
        const aliases = (m.requestedAliases || []).filter(a => a && a !== m._id);
        return {
          model_name: m._id || 'unknown',
          requested_aliases: aliases, // e.g. ["opus"] — what users asked for
          requests: m.requests,
          tokens: m.tokens,
          cost: modelSpend,
          spend: modelSpend,
          percentage: totalModelTokens > 0 ? ((m.tokens / totalModelTokens) * 100).toFixed(1) : '0.0',
        };
      }),
    });
  } catch (error) {
    console.error('User stats error:', error.message);
    return c.json({ error: 'Failed to fetch user stats' }, 500);
  }
});

// Recent requests for the current user — Overview "My Usage" tab
app.get('/api/overview/my-requests', requireUserOrAdmin(), async (c) => {
  try {
    const user = c.get('user');
    const keys = await apiKeys.find({ email: user.email, revoked: false }).toArray();
    const keyHashes = keys.map(k => k.keyHash).filter(Boolean);

    const matchClause = keyHashes.length
      ? { $or: [{ email: user.email }, { apiKeyHash: { $in: keyHashes } }] }
      : { email: user.email };

    const LIMIT = 50;
    const raw = await usageLogs
      .find(matchClause)
      .sort({ timestamp: -1 })
      .limit(LIMIT + 1) // fetch one extra to determine hasMore
      .toArray();

    const hasMore = raw.length > LIMIT;
    const requests = raw.slice(0, LIMIT).map(r => ({
      _id: r._id.toString(),
      requestedModel: r.requestedModel || null,
      actualModel: r.actualModel || r.model || null,
      endpoint: r.endpoint || null,
      promptTokens: r.promptTokens || 0,
      completionTokens: r.completionTokens || 0,
      totalTokens: r.tokens || 0,
      cost: calcCost(r.actualModel || r.model, r.promptTokens || 0, r.completionTokens || 0),
      timestamp: r.timestamp,
    }));

    return c.json({ requests, hasMore });
  } catch (error) {
    console.error('my-requests error:', error.message);
    return c.json({ error: 'Failed to fetch requests' }, 500);
  }
});

// Grouped/stacked requests — groups consecutive same-provider/model/endpoint requests
// GET /api/overview/requests/grouped?page=1&pageSize=20
app.get('/api/overview/requests/grouped', requireUserOrAdmin(), async (c) => {
  try {
    const user = c.get('user');
    const keys = await apiKeys.find({ email: user.email, revoked: false }).toArray();
    const keyHashes = keys.map(k => k.keyHash).filter(Boolean);

    const matchClause = keyHashes.length
      ? { $or: [{ email: user.email }, { apiKeyHash: { $in: keyHashes } }] }
      : { email: user.email };

    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') || '20', 10)));

    // Fetch ALL requests so grouping is consistent across pages.
    // Capped at 10k to protect memory; beyond that, grouping is done on the most recent 10k.
    const MAX_FETCH = 10000;

    const raw = await usageLogs
      .find(matchClause)
      .sort({ timestamp: -1 })
      .limit(MAX_FETCH)
      .toArray();

    // Get total request count for metadata
    const totalRequests = await usageLogs.countDocuments(matchClause);

    // Group consecutive requests by provider+model+endpoint (sequence-based, no time threshold)
    const allGroups = [];
    let groupCounter = 0;

    for (const r of raw) {
      const model = r.actualModel || r.model || null;
      const endpoint = r.endpoint || null;
      // Extract provider from model (e.g. "anthropic/claude-..." → "anthropic")
      const provider = model && model.includes('/') ? model.split('/')[0] : (model || 'unknown');
      const groupKey = `${provider}|${model}|${endpoint}`;
      const cost = calcCost(model, r.promptTokens || 0, r.completionTokens || 0);

      const item = {
        _id: r._id.toString(),
        requestedModel: r.requestedModel || null,
        actualModel: model,
        endpoint,
        promptTokens: r.promptTokens || 0,
        completionTokens: r.completionTokens || 0,
        totalTokens: r.tokens || 0,
        cost,
        timestamp: r.timestamp,
      };

      const lastGroup = allGroups.length > 0 ? allGroups[allGroups.length - 1] : null;

      if (lastGroup && lastGroup._groupKey === groupKey) {
        // Same model/provider/endpoint — merge into existing group (no time threshold)
        lastGroup.count += 1;
        lastGroup.totalTokens += item.totalTokens;
        lastGroup.totalSpend += item.cost;
        lastGroup.lastTimestamp = item.timestamp; // oldest (since sorted desc)
        lastGroup._itemIds.push(item._id);
      } else {
        // Different model (or first request) — start a new group
        groupCounter++;
        allGroups.push({
          id: `group-${groupCounter}`,
          _groupKey: groupKey,
          _itemIds: [item._id],
          provider,
          model,
          endpoint,
          count: 1,
          totalTokens: item.totalTokens,
          totalSpend: item.cost,
          firstTimestamp: item.timestamp,
          lastTimestamp: item.timestamp,
          items: null, // null until expanded
        });
      }
    }

    // Paginate the groups
    const totalGroups = allGroups.length;
    const totalPages = Math.ceil(totalGroups / pageSize);
    const offset = (page - 1) * pageSize;
    const pageGroups = allGroups.slice(offset, offset + pageSize);

    // Strip internal fields before returning
    const result = pageGroups.map(({ _groupKey, _itemIds, ...g }) => g);

    return c.json({
      groups: result,
      pagination: {
        page,
        pageSize,
        totalGroups,
        totalPages,
        hasMore: page < totalPages,
        totalRequests,
      },
    });
  } catch (error) {
    console.error('grouped-requests error:', error.message);
    return c.json({ error: 'Failed to fetch grouped requests' }, 500);
  }
});

// GET /api/overview/requests/group/:id/items — fetch individual items for a group on demand
// We can't use a persistent group ID (no DB), so we encode group params in query instead.
// The frontend passes: provider, model, endpoint, from, to (timestamps)
app.get('/api/overview/requests/group-items', requireUserOrAdmin(), async (c) => {
  try {
    const user = c.get('user');
    const keys = await apiKeys.find({ email: user.email, revoked: false }).toArray();
    const keyHashes = keys.map(k => k.keyHash).filter(Boolean);

    const matchClause = keyHashes.length
      ? { $or: [{ email: user.email }, { apiKeyHash: { $in: keyHashes } }] }
      : { email: user.email };

    const { model, endpoint, from, to } = c.req.query();
    if (!model || !from || !to) {
      return c.json({ error: 'model, from, to are required' }, 400);
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    // Add small buffer to ensure boundary items are included
    fromDate.setSeconds(fromDate.getSeconds() - 1);
    toDate.setSeconds(toDate.getSeconds() + 1);

    const filter = {
      ...matchClause,
      $or: [
        { actualModel: model },
        { model: model },
      ],
      ...(endpoint ? { endpoint } : {}),
      timestamp: { $gte: fromDate, $lte: toDate },
    };

    const raw = await usageLogs
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(100)
      .toArray();

    const items = raw.map(r => ({
      _id: r._id.toString(),
      requestedModel: r.requestedModel || null,
      actualModel: r.actualModel || r.model || null,
      endpoint: r.endpoint || null,
      promptTokens: r.promptTokens || 0,
      completionTokens: r.completionTokens || 0,
      totalTokens: r.tokens || 0,
      cost: calcCost(r.actualModel || r.model, r.promptTokens || 0, r.completionTokens || 0),
      timestamp: r.timestamp,
    }));

    return c.json({ items });
  } catch (error) {
    console.error('group-items error:', error.message);
    return c.json({ error: 'Failed to fetch group items' }, 500);
  }
});

// Per-user model usage breakdown (used by ModelUsagePieChart)
app.get('/api/dashboard/model-usage', requireUserOrAdmin(), async (c) => {
  try {
    const user = c.get('user');
    const keys = await apiKeys.find({ email: user.email, revoked: false }).toArray();
    const keyHashes = keys.map(k => k.keyHash).filter(Boolean);

    const matchClause = keyHashes.length
      ? { $or: [{ email: user.email }, { apiKeyHash: { $in: keyHashes } }] }
      : { email: user.email };

    const modelAgg = await usageLogs.aggregate([
      { $match: matchClause },
      {
        $group: {
          _id: '$model', // actualModel
          tokens: { $sum: '$tokens' },
          requests: { $sum: 1 },
          promptTokens: { $sum: '$promptTokens' },
          completionTokens: { $sum: '$completionTokens' },
          requestedAliases: { $addToSet: '$requestedModel' },
        }
      },
      { $sort: { tokens: -1 } }
    ]).toArray();

    const totalTokens = modelAgg.reduce((s, m) => s + m.tokens, 0);
    const result = modelAgg.map(m => {
      const spend = calcCost(m._id, m.promptTokens || 0, m.completionTokens || 0);
      const aliases = (m.requestedAliases || []).filter(a => a && a !== m._id);
      return {
        name: m._id || 'unknown',
        requested_aliases: aliases,
        value: m.tokens,
        requests: m.requests,
        spend,
        percentage: totalTokens > 0 ? ((m.tokens / totalTokens) * 100).toFixed(1) : '0.0',
      };
    });

    return c.json(result);
  } catch (error) {
    return c.json({ error: 'Failed to fetch model usage' }, 500);
  }
});

app.get('/api/dashboard/global-stats', async (c) => {
  try {
    const users = await validatedUsers.find({}).toArray();
    const keys = await apiKeys.find({ revoked: false }).toArray();
    
    // Fetch total spend
    const spendRes = await litellmFetch('/global/spend', {
      headers: { 'Authorization': _litellmAuthHeader }
    });
    let totalSpend = 0;
    if (spendRes.ok) {
      const data = await spendRes.json();
      totalSpend = data.spend || data.total_spend || 0;
    }

    // ── Model usage: single authoritative source — LiteLLM PostgreSQL ─────────────
    //
    // Source: LiteLLM_DailyUserSpend (PostgreSQL, direct query)
    //   - Tracks ALL requests that flow through LiteLLM proxy, all provider prefixes
    //   - Captures: anthropic/*, alibaba/*, chatgpt/*, codex/*, openai/*, etc.
    //   - No MongoDB involved for global model stats
    //
    // ⚠️  Known LiteLLM limitation (Responses API):
    //   - chatgpt/* models (OpenAI Responses API path) are under-counted in PG
    //   - e.g. chatgpt/gpt-5.3-codex shows 38 rows vs ~547 actual requests
    //   - This is a LiteLLM upstream bug: /v1/responses calls are not fully written
    //     to LiteLLM_DailyUserSpend. There is NO other LiteLLM-native table that
    //     captures these (SpendLogs also has 0 chatgpt/* rows).
    //   - Workaround: accept LiteLLM's partial count for Responses API models.
    //     The data shown is 100% LiteLLM-authoritative; the gap is in LiteLLM itself.
    // ──────────────────────────────────────────────────────────────────────────────

    let modelUsage = [];
    let totalRequests = 0;
    let totalTokens   = 0;
    try {
      const pgResult = await _pgPool.query(`
        SELECT
          model,
          SUM(api_requests)                        AS reqs,
          SUM(prompt_tokens + completion_tokens)   AS tokens,
          SUM(prompt_tokens)                       AS prompt_tokens,
          SUM(completion_tokens)                   AS completion_tokens
        FROM "LiteLLM_DailyUserSpend"
        WHERE model IS NOT NULL AND model <> '' AND model <> 'litellm-internal-health-check'
        GROUP BY model
        ORDER BY tokens DESC
      `);

      const rows = pgResult.rows;
      const totalTokensAgg = rows.reduce((s, r) => s + Number(r.tokens || 0), 0);

      modelUsage = rows.map(r => {
        const reqs = Number(r.reqs || 0);
        const tok  = Number(r.tokens || 0);
        const ptok = Number(r.prompt_tokens || 0);
        const ctok = Number(r.completion_tokens || 0);
        const modelSpend = calcCost(r.model, ptok, ctok);
        totalRequests += reqs;
        totalTokens   += tok;
        return {
          model_name: r.model,
          requests:   reqs,
          tokens:     tok,
          spend:      modelSpend,
          percentage: totalTokensAgg > 0 ? ((tok / totalTokensAgg) * 100).toFixed(1) : '0.0',
        };
      });

      console.log(`✅ Global stats (LiteLLM PG only): ${totalRequests.toLocaleString()} total reqs | ${modelUsage.length} models`);
    } catch (e) {
      console.error('Failed to load LiteLLM PG model activity:', e.message);
    }

    // ── Top users — from MongoDB usage_logs grouped by email ─────────────
    // MongoDB usage_logs tracks every proxied request with email + token counts.
    // This is the correct source: PG LiteLLM_DailyUserSpend uses its own key hashes
    // which don't map to our MongoDB keyHash values, so PG can't resolve email.
    const userKeyMap = {};
    for (const k of keys) {
      if (k.email) {
        userKeyMap[k.email] = userKeyMap[k.email] || [];
        userKeyMap[k.email].push(k);
      }
    }
    let topUsers = [];
    try {
      const usageAgg = await usageLogs.aggregate([
        { $group: {
          _id: '$email',
          requests: { $sum: 1 },
          tokens: { $sum: '$tokens' },
        }},
        { $sort: { requests: -1 } },
      ]).toArray();
      // Build email → usage map
      const emailUsageMap = {};
      for (const row of usageAgg) {
        if (row._id) emailUsageMap[row._id] = { requests: Number(row.requests || 0), tokens: Number(row.tokens || 0) };
      }
      topUsers = users
        .filter(u => u.email)
        .map(u => {
          const userKeys = userKeyMap[u.email] || [];
          const usage = emailUsageMap[u.email] || { requests: 0, tokens: 0 };
          return {
            email: u.email,
            role: u.role || 'user',
            requests: usage.requests,
            tokens: usage.tokens,
            spend: 0,
            keys: userKeys.length,
          };
        })
        .filter(u => u.keys > 0 || u.requests > 0)
        .sort((a, b) => (b.requests - a.requests) || (b.keys - a.keys));
    } catch (e) {
      console.error('Failed to build top users from usage_logs:', e.message);
      // Fallback: list users without usage stats
      topUsers = users
        .filter(u => u.email)
        .map(u => ({ email: u.email, role: u.role || 'user', requests: 0, tokens: 0, spend: 0, keys: (userKeyMap[u.email] || []).length }))
        .filter(u => u.keys > 0)
        .sort((a, b) => b.keys - a.keys);
    }

    return c.json({ totalUsers: users.length, activeKeys: keys.length, totalSpend, totalRequests, totalTokens, modelUsage, topUsers });
  } catch (error) {
    console.error('global-stats error:', error.message);
    return c.json({ error: 'Failed to fetch global stats' }, 500);
  }
});

app.get('/api/analytics/global', async (c) => {
  try {
    const users = await validatedUsers.find({}).toArray();
    const keys = await apiKeys.find({ revoked: false }).toArray();

    // Fetch live model count from LiteLLM (non-blocking, best-effort)
    let modelCount = 0;
    try {
      const modelRes = await litellmFetch('/model/info', { headers: { 'Authorization': _litellmAuthHeader }, signal: AbortSignal.timeout(3000) });
      if (modelRes.ok) { const md = await modelRes.json(); modelCount = (md.data || []).length; }
    } catch { /* ignore — analytics are non-critical */ }

    return c.json({ totalUsers: users.length, activeKeys: keys.length, models: modelCount });
  } catch (error) {
    return c.json({ error: 'Failed to fetch analytics' }, 500);
  }
});

// ============ SPA SERVING (TANSTACK ROUTER) ============
app.get('/api/auth/status', async (c) => {
  const sess = c.req.session;
  return c.json({ authenticated: !!(sess && sess.email) });
});

app.post('/api/auth/request-otp', async (c) => {
  try {
    const sess = c.req.session;
    const { email } = await c.req.json();
    
    if (!email) {
      return c.json({ error: 'Email required' }, 400);
    }

    // Per-email OTP rate limit: max 3 per hour
    const otpLimit = checkOtpRateLimit(email);
    if (!otpLimit.allowed) {
      console.warn(`⚠️ OTP rate limit hit for ${email} - retry in ${otpLimit.retryAfterMin} min`);
      return c.json({ 
        error: `Too many OTP requests. Please wait ${otpLimit.retryAfterMin} minute(s) before requesting another OTP.` 
      }, 429);
    }
    
    // Generate 6-digit numeric OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    // Delete any existing OTPs for this email
    await otps.deleteMany({ email });
    
    // Store OTP in database (not just session)
    const otpDoc = {
      email,
      otp,
      expiresAt,
      attempts: 0,
      createdAt: new Date()
    };
    await otps.insertOne(otpDoc);
    
    // Store OTP in session as backup
    if (sess) {
      sess.otp = otp;
      sess.otpEmail = email;
      sess.otpSentAt = Date.now();
      await sess.save();
    }
    
    // Send OTP via email - NUMERIC CODE ONLY, NO MAGIC LINKS
    const smtpReady = await verifyConnection();
    if (smtpReady) {
      await sendOTPCode(email, otp);
      console.log(`✅ OTP sent to ${email}: ${otp}`);
    } else {
      console.log(`📧 OTP for ${email}: ${otp} (SMTP not ready, logged to console)`);
    }
    
    return c.json({ 
      success: true,
      message: 'OTP sent to your email', 
      email,
      expiresAt: expiresAt.toISOString()
    });
  } catch (error) {
    console.error('❌ Failed to send OTP:', error.message);
    return c.json({ error: 'Failed to send OTP' }, 500);
  }
});

app.post('/api/auth/verify-otp', async (c) => {
  try {
    const sess = c.req.session;
    const { email, otp } = await c.req.json();
    
    // Validate OTP format (6 digits, numeric only)
    if (!otp || !/^\d{6}$/.test(otp)) {
      return c.json({ error: 'Invalid OTP format. Must be 6 digits.' }, 400);
    }
    
    if (!email) {
      return c.json({ error: 'Email required' }, 400);
    }
    
    // Find OTP in database
    const otpRecord = await otps.findOne({ 
      email, 
      otp,
      expiresAt: { $gt: new Date() }
    });
    
    if (!otpRecord) {
      // Fallback to session-based verification
      if (!sess || !sess.otp || !sess.otpEmail) {
        return c.json({ error: 'No OTP session found. Please request a new OTP.' }, 400);
      }
      
      // Check if OTP expired (10 minutes)
      if (Date.now() - sess.otpSentAt > 600000) {
        sess.otp = undefined;
        sess.otpEmail = undefined;
        sess.otpSentAt = undefined;
        await sess.save();
        return c.json({ error: 'OTP expired. Please request a new one.' }, 400);
      }
      
      // Verify OTP from session
      if (otp !== sess.otp) {
        return c.json({ error: 'Invalid OTP' }, 400);
      }
    }
    
    // OTP verified - delete it to prevent reuse
    if (otpRecord) {
      await otps.deleteOne({ _id: otpRecord._id });
    }
    
    // OTP verified - create or update user session
    const userEmail = email || sess.otpEmail;
    let user = await validatedUsers.findOne({ email: userEmail });
    
    if (!user) {
      // Create new user as guest (needs admin approval)
      user = { email: userEmail, role: 'guest', createdAt: new Date() };
      await validatedUsers.insertOne(user);
      
      // Check if access request already exists
      const existingRequest = await accessRequests.findOne({ email: userEmail });
      if (!existingRequest) {
        // Create access request record
        await accessRequests.insertOne({
          email: userEmail,
          status: 'pending',
          requestedAt: new Date(),
          otpVerified: true,
          ip: c.req.header('X-Forwarded-For') || 'unknown',
          userAgent: c.req.header('User-Agent') || 'unknown'
        });
        
        // Notify admin
        const adminEmail = process.env.ADMIN_EMAIL || process.env.PROTON_EMAIL;
        if (adminEmail) {
          try {
            await sendAdminNotification(userEmail, adminEmail);
            console.log(`📧 Admin notification sent to ${adminEmail}`);
          } catch (error) {
            console.error('Failed to notify admin:', error);
          }
        }
      }
    }
    
    // Clear OTP from session
    if (sess) {
      sess.otp = undefined;
      sess.otpEmail = undefined;
      sess.otpSentAt = undefined;
      sess.userId = user.email;
      sess.email = user.email;
      sess.role = user.role;
      await sess.save();
    }
    
    console.log(`✅ OTP verified for ${user.email} (role: ${user.role})`);
    return c.json({ 
      success: true,
      message: 'OTP verified. Awaiting admin approval.', 
      email: user.email, 
      role: user.role,
      status: 'pending'
    });
  } catch (error) {
    console.error('❌ Failed to verify OTP:', error.message);
    return c.json({ error: 'Failed to verify OTP' }, 500);
  }
});

// Auth page routes (from routes/auth.js)
app.get('/auth', (c) => {
  const filePath = path.join(__dirname, 'dist/index.html');
  return c.html(fs.readFileSync(filePath, 'utf-8'));
});

app.get('/dashboard', (c) => {
  const filePath = path.join(__dirname, 'dist/index.html');
  return c.html(fs.readFileSync(filePath, 'utf-8'));
});

app.get('/dashboard/*', (c) => {
  const filePath = path.join(__dirname, 'dist/index.html');
  return c.html(fs.readFileSync(filePath, 'utf-8'));
});

app.get('/admin', requireAdmin(), (c) => {
  const filePath = path.join(__dirname, 'dist/index.html');
  return c.html(fs.readFileSync(filePath, 'utf-8'));
});

app.get('/docs', (c) => {
  const filePath = path.join(__dirname, 'dist/index.html');
  return c.html(fs.readFileSync(filePath, 'utf-8'));
});

app.get('/analytics', requireUserOrAdmin(), (c) => {
  const filePath = path.join(__dirname, 'dist/index.html');
  return c.html(fs.readFileSync(filePath, 'utf-8'));
});

app.get('/settings', requireUserOrAdmin(), (c) => {
  const filePath = path.join(__dirname, 'dist/index.html');
  return c.html(fs.readFileSync(filePath, 'utf-8'));
});

app.get('/keys', requireUserOrAdmin(), (c) => {
  const filePath = path.join(__dirname, 'dist/index.html');
  return c.html(fs.readFileSync(filePath, 'utf-8'));
});

app.get('/', (c) => c.redirect('/auth'));
app.get('/status', (c) => c.redirect('/auth'));

// Serve static assets
app.get('/assets/*.css', (c) => {
  const fileName = c.req.path.split('/').pop();
  const filePath = path.join(__dirname, 'dist/assets', fileName);
  if (fs.existsSync(filePath)) {
    c.header('Content-Type', 'text/css');
    return c.body(fs.readFileSync(filePath), 200);
  }
  return c.body('Not found', 404);
});

app.get('/assets/*.js', (c) => {
  const fileName = c.req.path.split('/').pop();
  const filePath = path.join(__dirname, 'dist/assets', fileName);
  if (fs.existsSync(filePath)) {
    c.header('Content-Type', 'application/javascript');
    return c.body(fs.readFileSync(filePath), 200);
  }
  return c.body('Not found', 404);
});

// Serve branding/PWA static files
const staticFiles = {
  '/favicon.ico': { mime: 'image/x-icon' },
  '/manifest.json': { mime: 'application/manifest+json' },
  '/icon-16.png': { mime: 'image/png' },
  '/icon-32.png': { mime: 'image/png' },
  '/icon-128.png': { mime: 'image/png' },
  '/icon-192.png': { mime: 'image/png' },
  '/icon-512.png': { mime: 'image/png' },
  '/apple-touch-icon.png': { mime: 'image/png' },
  '/og-image.png': { mime: 'image/png' },
  '/twitter-card.png': { mime: 'image/png' },
};

for (const [route, { mime }] of Object.entries(staticFiles)) {
  app.get(route, (c) => {
    const filePath = path.join(__dirname, 'dist', route);
    if (fs.existsSync(filePath)) {
      c.header('Content-Type', mime);
      c.header('Cache-Control', 'public, max-age=86400');
      return c.body(fs.readFileSync(filePath), 200);
    }
    return c.body('Not found', 404);
  });
}

// Setup scripts
app.get('/setup/claude-code.sh', (c) => {
  const script = `#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────
#  LLM Gateway — Claude Code setup script
#  https://llm.0xmemo.com
# ──────────────────────────────────────────────

GATEWAY_URL="https://llm.0xmemo.com"

echo ""
echo "🤖 LLM Gateway — Claude Code Setup"
echo "──────────────────────────────────"
echo ""

# 1. Check Claude Code is installed
if ! command -v claude &> /dev/null; then
  echo "❌ Claude Code not found."
  echo "   Install it with: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

# 2. Read API key from env var or prompt interactively
API_KEY="\${LLM_GATEWAY_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  echo -n "Enter your LLM Gateway API key: "
  read -r API_KEY
fi
if [ -z "$API_KEY" ]; then
  echo "❌ No API key provided. Aborting."
  exit 1
fi

# 3. Ensure jq is available (needed for non-destructive merge)
if ! command -v jq &> /dev/null; then
  echo "⚠️  jq not found. Installing..."
  if [[ "\${OSTYPE:-}" == "darwin"* ]]; then
    brew install jq
  else
    sudo apt-get update -qq && sudo apt-get install -y -qq jq
  fi
fi

# 4. Create ~/.claude directory
mkdir -p ~/.claude

# 5. Merge ~/.claude/settings.json (non-destructive)
if [ -f ~/.claude/settings.json ]; then
  jq --arg url "$GATEWAY_URL" --arg key "$API_KEY" '
    .env.ANTHROPIC_BASE_URL = $url |
    .env.ANTHROPIC_AUTH_TOKEN = $key |
    .env.ANTHROPIC_DEFAULT_OPUS_MODEL = "ultra" |
    .env.ANTHROPIC_DEFAULT_SONNET_MODEL = "plus" |
    .env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "lite" |
    .model = "opus" |
    .skipDangerousModePermissionPrompt = true
  ' ~/.claude/settings.json > /tmp/claude-settings.json && \\
  mv /tmp/claude-settings.json ~/.claude/settings.json
else
  cat > ~/.claude/settings.json << EOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "$GATEWAY_URL",
    "ANTHROPIC_AUTH_TOKEN": "$API_KEY",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "ultra",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "plus",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "lite"
  },
  "model": "opus",
  "skipDangerousModePermissionPrompt": true
}
EOF
fi

# 6. Merge ~/.claude.json (non-destructive, bypass onboarding)
if [ -f ~/.claude.json ]; then
  jq '.hasCompletedOnboarding = true' ~/.claude.json > /tmp/claude-dot.json && \\
  mv /tmp/claude-dot.json ~/.claude.json
else
  echo '{"hasCompletedOnboarding":true}' > ~/.claude.json
fi

echo ""
echo "✅ Claude Code configured for LLM Gateway!"
echo "   Base URL : $GATEWAY_URL"
echo "   Models   : ultra (opus) / plus (sonnet) / lite (haiku)"
echo ""
echo "Run \`claude\` to start coding 🚀"
`;
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', 'no-cache');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(script, 200);
});

// Catch-all for SPA - must be AFTER all other routes
app.get('/*', (c) => {
  const filePath = path.join(__dirname, 'dist/index.html');
  return c.html(fs.readFileSync(filePath, 'utf-8'));
});

// Start server
console.log('🚀 LLM Gateway - Thin Proxy');
console.log(`📍 LiteLLM: ${LITELLM_URL}`);
console.log(`📍 Server: http://localhost:${process.env.PORT || 3000}`);

serve({
  fetch: app.fetch,
  port: parseInt(process.env.PORT || '3000'),
  hostname: process.env.HOST || '0.0.0.0'
});
