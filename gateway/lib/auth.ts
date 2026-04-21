/**
 * JWT session signing/verification + request helpers.
 *
 * Role-based access gates (requireAuth / requireUser / requireAdmin) live
 * in lib/db.ts and use the helpers below for session extraction.
 */

import { SignJWT, jwtVerify } from 'jose';

const SESSION_SECRET = process.env.GATEWAY_SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error(
    'GATEWAY_SESSION_SECRET must be set to a value of at least 32 chars. ' +
      'Generate one with: head -c 48 /dev/urandom | base64 | tr -d =+/ | head -c 48',
  );
}
const secret = new TextEncoder().encode(SESSION_SECRET);

export async function signSession(payload: any): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1y')
    .sign(secret);
}

export async function verifySession(token: string): Promise<any> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload;
  } catch {
    return null;
  }
}

export function getSessionCookie(req: Request): string | null {
  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  const match = cookie.match(/sessionId=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Extract API key from request headers.
 * Supports: `Authorization: Bearer sk-xxx`, `Authorization: sk-xxx`, `x-api-key: sk-xxx`.
 */
export function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.get('Authorization');
  if (authHeader) {
    const key = authHeader.startsWith('Bearer ') || authHeader.startsWith('bearer ')
      ? authHeader.replace(/^Bearer\s+/i, '').trim()
      : authHeader.trim();
    if (key) return key;
  }

  const apiKeyHeader = req.headers.get('x-api-key');
  if (apiKeyHeader) return apiKeyHeader.trim();

  return null;
}
