/**
 * LLM API Gateway - Bun Stack
 *
 * A lightweight authentication and rate-limiting proxy for LiteLLM.
 * Built with Bun.serve() for simplicity and performance.
 */

import { MongoClient } from 'mongodb';
import { signSession, verifySession, getSessionCookie, extractApiKey } from './lib/auth';
import { sendOTPCode } from './lib/email-service.js';
import { generateOTP } from './lib/otp.js';
import { createHash } from 'crypto';

// ============================================================================
// CONFIGURATION
// ============================================================================

const LITELLM_URL = process.env.LITELLM_URL || process.env.LITELLM_PROXY_URL || 'http://localhost:4040';
const LITELLM_AUTH = `Bearer ${process.env.LITELLM_MASTER_KEY || ''}`;
const PORT = process.env.PORT || 14041;

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

  const client = new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 20,
    minPoolSize: 5,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
  });

  await client.connect();
  db = client.db('llm-gateway');
  accessRequests = db.collection('access_requests');
  apiKeys = db.collection('api_keys');
  validatedUsers = db.collection('validated_users');
  otps = db.collection('otps');
  usageLogs = db.collection('usage_logs');
  sessions = db.collection('sessions');

  // Indexes
  await apiKeys.createIndex({ key: 1 }, { unique: true });
  await apiKeys.createIndex({ keyHash: 1 }, { sparse: true });
  await validatedUsers.createIndex({ email: 1 }, { unique: true });
  await otps.createIndex({ email: 1, expiresAt: 1 });
  await usageLogs.createIndex({ apiKeyHash: 1, timestamp: -1 });
  await usageLogs.createIndex({ email: 1, timestamp: -1 });
  await usageLogs.createIndex({ timestamp: -1 });
  await sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });

  console.log('✅ MongoDB connected (LLM Gateway - Bun Stack)');
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
  const keyHash = createHash('sha256').update(apiKey.trim()).digest('hex');

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
  const bcrypt = await import('bcryptjs');
  const legacyKeys = await apiKeys.find({ revoked: false, keyType: { $ne: 'sha256' } }).toArray();
  for (const k of legacyKeys) {
    const match = await bcrypt.default.compare(apiKey.trim(), k.key);
    if (match) {
      await apiKeys.updateOne({ _id: k._id }, { $set: { keyHash, keyType: 'sha256' } });
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

function checkRateLimit(ip: string, windowMs = 60000, limit = 100): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record) {
    rateLimitMap.set(ip, { count: 1, startTime: now });
    return true;
  }

  if (now - record.startTime > windowMs) {
    record.count = 1;
    record.startTime = now;
  } else {
    record.count++;
    if (record.count > limit) return false;
  }
  return true;
}

function checkOtpRateLimit(email: string): { allowed: boolean; remaining?: number; retryAfterMin?: number } {
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
    console.error('⚠️ Usage batch insert failed:', err.message);
  }
}

setInterval(() => { flushUsageQueue().catch(() => {}); }, 2000).unref();

function trackUsage(email: string, model: string, promptTokens: number, completionTokens: number, apiKeyHash: string | null) {
  const pricing: Record<string, { input: number; output: number }> = {
    'claude-opus-4-6': { input: 0.000005, output: 0.000025 },
    'claude-sonnet-4-6': { input: 0.000003, output: 0.000015 },
    'claude-haiku-4-5': { input: 0.000001, output: 0.000005 },
    'gpt-4o': { input: 0.0000025, output: 0.00001 },
    'gpt-4o-mini': { input: 0.00000015, output: 0.0000006 },
    'sonnet': { input: 0.000003, output: 0.000015 },
    'opus': { input: 0.000005, output: 0.000025 },
    'haiku': { input: 0.000001, output: 0.000005 },
  };

  const rates = pricing[model] || pricing[model.replace(/-\d{8}$/, '')] || { input: 0, output: 0 };
  const cost = (promptTokens * rates.input) + (completionTokens * rates.output);

  _usageQueue.push({
    email,
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
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
  return Response.json({ status: 'ok', uptime: process.uptime() });
}

// Serve frontend
async function serveFrontend() {
  const file = Bun.file('./index.html');
  return new Response(await file.text(), {
    headers: { 'Content-Type': 'text/html' }
  });
}

// Serve static files
async function serveStaticFile(path: string): Promise<Response | null> {
  const file = Bun.file(`.${path}`);
  if (await file.exists()) {
    const contentType = getContentType(path);
    return new Response(await file.arrayBuffer(), {
      headers: { 'Content-Type': contentType }
    });
  }
  return null;
}

function getContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    'css': 'text/css',
    'js': 'application/javascript',
    'mjs': 'application/javascript',
    'ts': 'application/typescript',
    'tsx': 'application/typescript',
    'html': 'text/html',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
  };
  return types[ext || 'text/plain'] || 'text/plain';
}

// OTP request
async function requestOtpHandler(req: Request) {
  const { email } = await req.json();

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'Valid email required' }, { status: 400 });
  }

  const limit = checkOtpRateLimit(email);
  if (!limit.allowed) {
    return Response.json({
      error: `Too many attempts. Try again in ${limit.retryAfterMin} minutes.`
    }, { status: 429 });
  }

  const code = generateOTP();
  await otps.insertOne({
    email: email.toLowerCase(),
    code,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    createdAt: new Date(),
  });

  await sendOTPCode(email, code);

  await validatedUsers.updateOne(
    { email: email.toLowerCase() },
    {
      $set: { email: email.toLowerCase(), role: 'guest' },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );

  return Response.json({ success: true, message: 'Code sent!' });
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
    return Response.json({ error: 'Invalid or expired code' }, { status: 400 });
  }

  await otps.deleteOne({ _id: otpRecord._id });

  const user = await validatedUsers.findOne({ email: email.toLowerCase() });
  if (!user) {
    await validatedUsers.insertOne({
      email: email.toLowerCase(),
      role: 'guest',
      createdAt: new Date(),
    });
  }

  // Create session
  const sessionId = crypto.randomUUID();
  const sessionToken = await signSession({
    sessionId,
    userId: email.toLowerCase(),
    email: email.toLowerCase(),
    role: 'guest',
  });

  await sessions.insertOne({
    _id: sessionId,
    session: JSON.stringify({
      sessionId,
      userId: email.toLowerCase(),
      email: email.toLowerCase(),
      role: 'guest',
      cookie: { expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) }
    }),
    expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });

  const response = Response.json({ success: true, role: 'guest' });
  response.headers.set('Set-Cookie', `sessionId=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${365 * 24 * 60 * 60}`);
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

// Logout
async function logoutHandler() {
  const response = Response.json({ success: true });
  response.headers.set('Set-Cookie', 'sessionId=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return response;
}

// API Keys
async function getApiKeysHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken) return Response.json({ error: 'Authentication required' }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session) return Response.json({ error: 'Authentication required' }, { status: 401 });

  const user = await loadUser(session.email);
  if (!user || user.role === 'guest') {
    return Response.json({ error: 'User access required' }, { status: 403 });
  }

  const keys = await apiKeys.find({ email: user.email }).toArray();
  return Response.json({ keys });
}

async function createApiKeyHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken) return Response.json({ error: 'Authentication required' }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session) return Response.json({ error: 'Authentication required' }, { status: 401 });

  const user = await loadUser(session.email);
  if (!user || user.role === 'guest') {
    return Response.json({ error: 'User access required' }, { status: 403 });
  }

  const { name } = await req.json();
  const key = `sk_${crypto.randomBytes(16).toString('hex')}`;
  const keyHash = createHash('sha256').update(key.trim()).digest('hex');

  await apiKeys.insertOne({
    email: user.email,
    name: name || 'Unnamed Key',
    key,
    keyHash,
    keyType: 'sha256',
    revoked: false,
    createdAt: new Date(),
  });

  return Response.json({ success: true, key, name });
}

async function revokeApiKeyHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken) return Response.json({ error: 'Authentication required' }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session) return Response.json({ error: 'Authentication required' }, { status: 401 });

  const user = await loadUser(session.email);
  if (!user || user.role === 'guest') {
    return Response.json({ error: 'User access required' }, { status: 403 });
  }

  const { keyId } = await req.json();
  await apiKeys.updateOne(
    { _id: keyId, email: user.email },
    { $set: { revoked: true, revokedAt: new Date() } }
  );

  return Response.json({ success: true });
}

// Models
async function getModelsHandler() {
  const res = await fetch(`${LITELLM_URL}/model/info`, {
    headers: { 'Authorization': LITELLM_AUTH },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    return Response.json({ error: 'Failed to fetch models' }, { status: res.status });
  }

  const data = await res.json();
  return Response.json({ models: data.data || [], count: data.data?.length || 0 });
}

// Admin: pending requests
async function getPendingRequestsHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken) return Response.json({ error: 'Authentication required' }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session) return Response.json({ error: 'Authentication required' }, { status: 401 });

  const user = await loadUser(session.email);
  if (!user || user.role !== 'admin') {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  const requests = await accessRequests.find({ status: 'pending' }).toArray();
  return Response.json({ requests });
}

// Admin: approve user
async function approveUserHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken) return Response.json({ error: 'Authentication required' }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session) return Response.json({ error: 'Authentication required' }, { status: 401 });

  const user = await loadUser(session.email);
  if (!user || user.role !== 'admin') {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  const { email } = await req.json();
  await validatedUsers.updateOne(
    { email: email.toLowerCase() },
    { $set: { role: 'user', approvedAt: new Date() } }
  );

  userProfileCache.delete(email.toLowerCase());
  return Response.json({ success: true });
}

// LiteLLM Proxy
async function proxyHandler(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v1/, '');
  const targetUrl = `${LITELLM_URL}/v1${path}${url.search}`;

  const apiKey = extractApiKey(req);
  let email: string | null = null;
  let keyHash: string | null = null;

  if (apiKey) {
    const keyRecord = await validateApiKey(apiKey);
    if (!keyRecord) {
      return Response.json({ error: 'Invalid API key' }, { status: 401 });
    }
    email = keyRecord.email;
    keyHash = keyRecord.keyHash;
  } else {
    const sessionToken = getSessionCookie(req);
    if (sessionToken) {
      const session = await verifySession(sessionToken);
      if (session) {
        const user = await loadUser(session.email);
        if (user && user.role !== 'guest') {
          email = user.email;
        }
      }
    }
  }

  if (!email) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  // Read body for usage tracking
  const body = await req.text();
  let bodyObj: any = {};
  try { bodyObj = JSON.parse(body); } catch {}

  const model = bodyObj.model || 'unknown';

  // Forward request
  const headers = new Headers(req.headers);
  headers.set('Authorization', LITELLM_AUTH);
  headers.delete('x-api-key');

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
        trackUsage(email!, model, usage.prompt_tokens || 0, usage.completion_tokens || 0, keyHash);
      }
    } catch {}
  }

  return proxyRes;
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

const server = Bun.serve({
  port: PORT,

  routes: {
    // Static files
    '/public/*': async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const response = await serveStaticFile(path);
      return response || new Response('Not found', { status: 404 });
    },
    '/src/index.css': async (req) => {
      const response = await serveStaticFile('/src/index.css');
      return response || new Response('Not found', { status: 404 });
    },

    // Health
    '/api/health': { GET: healthHandler },

    // Auth
    '/api/auth/request-otp': { POST: requestOtpHandler },
    '/api/auth/verify-otp': { POST: verifyOtpHandler },
    '/api/auth/status': { GET: sessionStatusHandler },
    '/api/auth/logout': { GET: logoutHandler },

    // API Keys
    '/api/keys': { GET: getApiKeysHandler, POST: createApiKeyHandler },
    '/api/keys/revoke': { POST: revokeApiKeyHandler },

    // Models
    '/api/models': { GET: getModelsHandler },

    // Admin
    '/api/admin/pending': { GET: getPendingRequestsHandler },
    '/api/admin/approve': { POST: approveUserHandler },

    // Proxy (LiteLLM)
    '/v1/chat/completions': { POST: proxyHandler },
    '/v1/embeddings': { POST: proxyHandler },
    '/v1/completions': { POST: proxyHandler },
    '/v1/audio/transcriptions': { POST: proxyHandler },
    '/v1/models': { GET: proxyHandler },
    '/v1/model/info': { GET: proxyHandler },

    // Frontend - serve index.html for all UI routes
    '/auth': { GET: serveFrontend },
    '/dashboard': { GET: serveFrontend },
    '/dashboard/*': { GET: serveFrontend },

    // Root
    '/': { GET: () => Response.redirect('/dashboard', 302) },
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Server running at http://localhost:${PORT}`);
