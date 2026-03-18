/**
 * E2E Test: Session Cookie Persistence
 * 
 * Verifies:
 * - Secure, HttpOnly, SameSite=Strict cookies
 * - 1-year expiry
 * - MongoDB session persistence
 * - Cookie survives "browser restart" (re-use of cookie across requests)
 * 
 * Run: node tests/session-persistence.test.mjs
 * (requires .env with MONGODB_URI and gateway running on port 3002)
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3002';

// Simulate nginx proxy headers (real users come through nginx with HTTPS)
const PROXY_HEADERS = {
  'X-Forwarded-Proto': 'https',
  'X-Forwarded-For': '1.2.3.4'
};

const jar = new Map();
const errors = [];
let passed = 0;

function extractCookies(headers) {
  const setCookie = headers.get('set-cookie');
  if (!setCookie) return null;
  const firstPart = setCookie.split(';')[0];
  const eq = firstPart.indexOf('=');
  if (eq > 0) {
    return { name: firstPart.substring(0, eq).trim(), value: firstPart.substring(eq + 1).trim(), raw: setCookie };
  }
  return null;
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function assert(condition, message) {
  if (condition) {
    console.log(`   ✅ ${message}`);
    passed++;
  } else {
    console.log(`   ❌ FAIL: ${message}`);
    errors.push(message);
  }
}

console.log('\n🧪 E2E Session Persistence Test\n');
console.log(`   Base URL: ${BASE}`);
console.log(`   Simulating nginx proxy: X-Forwarded-Proto: https\n`);

// 1. Unauthenticated state
console.log('1. Auth status without cookie...');
const r1 = await fetch(`${BASE}/api/auth/status`, { headers: PROXY_HEADERS });
const d1 = await r1.json();
assert(!d1.authenticated, 'Unauthenticated without cookie');
assert(!r1.headers.get('set-cookie'), 'No cookie for anonymous (saveUninitialized=false)');

// 2. Request OTP — triggers session creation + cookie
const testEmail = `e2e-persist-${Date.now()}@test.com`;
console.log(`\n2. Requesting OTP for ${testEmail}...`);
const r2 = await fetch(`${BASE}/api/auth/request-otp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...PROXY_HEADERS },
  body: JSON.stringify({ email: testEmail })
});
const c2 = extractCookies(r2.headers);
const d2 = await r2.json();
assert(d2.success, 'OTP request succeeds');
assert(c2 !== null, 'Cookie received after OTP request');
if (c2) {
  jar.set(c2.name, c2.value);
  assert(c2.raw.includes('Secure'), 'Cookie has Secure flag');
  assert(c2.raw.includes('HttpOnly'), 'Cookie has HttpOnly flag');
  assert(c2.raw.toLowerCase().includes('samesite=strict'), 'Cookie has SameSite=Strict');
  assert(c2.raw.includes('Expires='), 'Cookie has Expires (persistent, not session-only)');
  const expires = new Date(c2.raw.match(/Expires=([^;]+)/)?.[1]);
  const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000 - 60000);
  assert(expires > oneYearFromNow, `Cookie expires ≥1 year: ${expires.toISOString()}`);
}

// 3. Fetch OTP from DB
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db('llm-gateway');
const otpDoc = await db.collection('otps').findOne({ email: testEmail });
assert(otpDoc !== null, 'OTP stored in MongoDB');
console.log(`\n3. Got OTP from DB: ${otpDoc?.otp}`);

// 4. Verify OTP (with cookie from step 2)
console.log('\n4. Verifying OTP...');
const r4 = await fetch(`${BASE}/api/auth/verify-otp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Cookie': cookieHeader(), ...PROXY_HEADERS },
  body: JSON.stringify({ email: testEmail, otp: otpDoc.otp })
});
const c4 = extractCookies(r4.headers);
const d4 = await r4.json();
assert(d4.success, 'OTP verified successfully');
if (c4) jar.set(c4.name, c4.value);

// 5. Verify MongoDB session
console.log('\n5. Checking MongoDB session...');
// Small delay to allow session write
await new Promise(r => setTimeout(r, 500));
const sessionByEmail = await db.collection('sessions').findOne({ session: { $regex: testEmail } });
if (sessionByEmail) {
  const sessionData = JSON.parse(sessionByEmail.session);
  assert(sessionData.email === testEmail, `Session has correct email`);
  assert(sessionData.userId !== undefined, 'Session has userId');
  assert(sessionByEmail.expires > new Date(), 'Session not expired');
  const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000 - 60000);
  assert(sessionByEmail.expires > oneYearFromNow, `MongoDB session TTL ≥1 year: ${sessionByEmail.expires.toISOString()}`);
  // TTL index check
  const indexes = await db.collection('sessions').indexes();
  const ttlIndex = indexes.find(i => i.expireAfterSeconds === 0 && i.key?.expires);
  assert(ttlIndex !== undefined, 'TTL index on sessions.expires exists');
} else {
  assert(false, 'Session found in MongoDB');
}

// 6. Simulate browser restart — use saved cookie
console.log('\n6. Simulating browser restart (using saved cookie)...');
const r6 = await fetch(`${BASE}/api/auth/status`, {
  headers: { 'Cookie': cookieHeader(), ...PROXY_HEADERS }
});
const d6 = await r6.json();
assert(d6.authenticated, '✅ Session persists across browser restart!');

// 7. Protected endpoint accessible
console.log('\n7. Accessing protected endpoint /api/auth/me...');
const r7 = await fetch(`${BASE}/api/auth/me`, {
  headers: { 'Cookie': cookieHeader(), ...PROXY_HEADERS }
});
assert(r7.status !== 401, 'Protected endpoint: session recognized (not 401 Unauthorized)');

await client.close();

// Summary
console.log('\n─────────────────────────────');
console.log(`\n📊 Results: ${passed} passed, ${errors.length} failed`);
if (errors.length > 0) {
  console.log('❌ Failed:', errors.join('\n   '));
  process.exit(1);
} else {
  console.log('✅ ALL TESTS PASSED — Session persistence working!\n');
}
