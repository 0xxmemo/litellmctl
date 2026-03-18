/**
 * Simplified authentication middleware for Bun-stack LLM Gateway
 *
 * Provides role-based access control without complex middleware chains.
 * Uses JWT-based sessions with MongoDB storage.
 */

import { SignJWT, jwtVerify } from 'jose';

const SESSION_SECRET = process.env.SESSION_SECRET || 'your-secret-min-32-chars';
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
 * Supports multiple formats:
 * - Authorization: Bearer sk-xxx
 * - Authorization: sk-xxx
 * - x-api-key: sk-xxx
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

/**
 * Require session middleware factory.
 * Returns a function that checks for valid session.
 */
export function requireSession() {
  return async (req: Request, db: any): Promise<{ valid: boolean; session?: any; user?: any }> => {
    const sessionToken = getSessionCookie(req);
    if (!sessionToken) {
      return { valid: false };
    }

    const session = await verifySession(sessionToken);
    if (!session) {
      return { valid: false };
    }

    const user = await db.collection('validated_users').findOne({ email: session.email });
    if (!user) {
      return { valid: false };
    }

    return { valid: true, session, user };
  };
}

/**
 * Require specific role(s) middleware.
 * Usage: const check = requireRole('user', 'admin');
 *        const result = await check(req, db);
 */
export function requireRole(...allowedRoles: string[]) {
  return async (req: Request, db: any): Promise<{ valid: boolean; session?: any; user?: any; error?: string }> => {
    const sessionCheck = await requireSession()(req, db);
    if (!sessionCheck.valid) {
      return { valid: false, error: 'Authentication required' };
    }

    if (!allowedRoles.includes(sessionCheck.user.role)) {
      return {
        valid: false,
        error: `Access denied. Required role: ${allowedRoles.join(' or ')}`,
      };
    }

    return sessionCheck;
  };
}

export const requireAdmin = () => requireRole('admin');
export const requireUser = () => requireRole('user', 'admin');

/**
 * Combined API key or session check.
 * Returns either a valid API key record or a valid session user.
 */
export async function requiresApiKeyOrSession(req: Request, db: any): Promise<{
  valid: boolean;
  email: string | null;
  keyHash?: string | null;
  user?: any;
  error?: string;
}> {
  const apiKey = extractApiKey(req);

  if (apiKey) {
    const { createHash } = await import('crypto');
    const keyHash = createHash('sha256').update(apiKey.trim()).digest('hex');

    // Check cache first
    const cachedKey = db.apiKeyCache?.get(keyHash);
    if (cachedKey && Date.now() - cachedKey.timestamp < 300000) {
      if (!cachedKey.revoked) {
        return { valid: true, email: cachedKey.email, keyHash };
      }
    }

    const keyRecord = await db.collection('api_keys').findOne({ keyHash, revoked: false });
    if (keyRecord) {
      // Cache the result
      if (db.apiKeyCache) {
        db.apiKeyCache.set(keyHash, { ...keyRecord, timestamp: Date.now() });
      }
      return { valid: true, email: keyRecord.email, keyHash };
    }

    return { valid: false, email: null, error: 'Invalid API key' };
  }

  // No API key, try session
  const sessionCheck = await requireSession()(req, db);
  if (sessionCheck.valid && sessionCheck.user.role !== 'guest') {
    return { valid: true, email: sessionCheck.user.email, user: sessionCheck.user };
  }

  return { valid: false, email: null, error: 'Authentication required' };
}
