import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "crypto";
import { verifySession, getSessionCookie, extractApiKey } from "./auth";
import { errorMessage } from "./errors";

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

export let db: Database = null as unknown as Database;
let vecLoaded = false;

function resolveDbPath(): string {
  const override = process.env.GATEWAY_DB_PATH;
  if (override) return override;
  return new URL("../gateway.db", import.meta.url).pathname;
}

function tryLoadVec() {
  const candidates = [
    "vec0",                        // Homebrew default
    "/opt/homebrew/lib/vec0",
    "/usr/local/lib/vec0",
    "/usr/lib/sqlite-vec/vec0",
    process.env.SQLITE_VEC_PATH,
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      db.loadExtension(p);
      vecLoaded = true;
      console.log(`✅ sqlite-vec loaded (${p})`);
      return;
    } catch {}
  }
  console.warn(
    "⚠️  sqlite-vec not loaded — vector features disabled. " +
      "Install via 'brew install asg017/sqlite-vec/sqlite-vec' (macOS) " +
      "or build from https://github.com/asg017/sqlite-vec.",
  );
}

export async function connectDB(): Promise<void> {
  if (db) return;
  const path = resolveDbPath();
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode=WAL;");
  db.run("PRAGMA foreign_keys=ON;");
  db.run("PRAGMA busy_timeout=5000;");

  const schema = `
    CREATE TABLE IF NOT EXISTS validated_users (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'guest',
      name TEXT,
      company TEXT,
      model_overrides TEXT,
      created_at INTEGER NOT NULL,
      approved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT UNIQUE NOT NULL,
      name TEXT,
      alias TEXT,
      email TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_email
      ON api_keys(email, revoked, created_at DESC);

    CREATE TABLE IF NOT EXISTS otps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email, expires_at);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      session TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      model TEXT NOT NULL,
      actual_model TEXT,
      requested_model TEXT,
      endpoint TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      api_key_hash TEXT,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_email_ts
      ON usage_logs(email, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_key_ts
      ON usage_logs(api_key_hash, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_email_model_ts
      ON usage_logs(email, model, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_email_actual_ts
      ON usage_logs(email, actual_model, timestamp DESC);

    -- plugin_* tables: shared across all authenticated clients. Branch-
    -- level isolation is expressed via plugin_ref_chunks overlays, not per-
    -- tenant row scoping. See docs/claude-context.md for the data model.
    CREATE TABLE IF NOT EXISTS plugin_collections (
      name TEXT PRIMARY KEY,
      dimension INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plugin_chunks (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      content TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      file_extension TEXT,
      metadata TEXT,
      UNIQUE(collection, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_chunks_collection
      ON plugin_chunks(collection);

    CREATE TABLE IF NOT EXISTS plugin_ref_chunks (
      collection TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (collection, ref_id, file_path, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ref_chunks_ref
      ON plugin_ref_chunks(collection, ref_id);
    CREATE INDEX IF NOT EXISTS idx_ref_chunks_chunk
      ON plugin_ref_chunks(collection, chunk_id);

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      email TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_team_members_email ON team_members(email);
  `;

  // One-shot cleanup of pre-v2 per-tenant rows. Detect via the legacy
  // `api_key_hash` column; drop both plugin_* tables + all vec partitions so
  // the fresh schema can take over cleanly. The data was barely used and is
  // cheaper to re-index than to migrate.
  const legacy = db
    .prepare("PRAGMA table_info(plugin_chunks)")
    .all() as { name: string }[];
  if (legacy.some((c) => c.name === "api_key_hash")) {
    console.log("[db] Dropping legacy per-tenant plugin_* tables (pre-v2 schema)");
    db.run("DROP TABLE IF EXISTS plugin_chunks");
    db.run("DROP TABLE IF EXISTS plugin_collections");
    const vecTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plugin_chunks_vec_%'",
      )
      .all() as { name: string }[];
    for (const t of vecTables) db.run(`DROP TABLE IF EXISTS ${t.name}`);
  }

  for (const stmt of schema.split(";")) {
    const trimmed = stmt.trim();
    if (trimmed) db.run(trimmed);
  }

  tryLoadVec();
  console.log(`✅ SQLite connected (${path})`);

  // Promote every email in GATEWAY_ADMIN_EMAILS to admin at startup.
  // Idempotent: existing admins stay admin, existing guests upgrade,
  // brand-new admins get seeded with approved_at set. Lets a deploy
  // rotate the admin list via .env without anyone having to re-login.
  promoteConfiguredAdmins();

  scheduleVectorGc();
}

/**
 * Periodically drop chunks that no ref overlay references any more. Cheap
 * when the collection is fresh (delete returns 0 rows); bounds disk growth
 * when teams churn through branches. Runs every 6h after a short initial
 * delay so it doesn't fight startup I/O.
 */
function scheduleVectorGc(): void {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const INITIAL_DELAY_MS = 5 * 60 * 1000;
  const run = async () => {
    try {
      const { gcOrphanedChunks } = await import("./vectordb");
      const res = gcOrphanedChunks();
      if (res.chunksRemoved > 0 || res.vecRemoved > 0) {
        console.log(
          `[vectordb-gc] removed ${res.chunksRemoved} chunks, ${res.vecRemoved} vectors`,
        );
      }
    } catch (err) {
      console.warn("[vectordb-gc] skipped:", err instanceof Error ? err.message : err);
    }
  };
  setTimeout(() => {
    run();
    setInterval(run, SIX_HOURS_MS);
  }, INITIAL_DELAY_MS);
}

export function dbHealthy(): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

export function isVecLoaded(): boolean {
  return vecLoaded;
}

// ============================================================================
// TYPES
// ============================================================================

export interface UserRecord {
  email: string;
  role: string;
  name: string | null;
  company: string | null;
  model_overrides: Record<string, string>;
  createdAt: number;
  approvedAt: number | null;
}

export interface ApiKeyRecord {
  id: string;
  keyHash: string;
  name: string | null;
  alias: string | null;
  email: string;
  revoked: boolean;
  createdAt: number;
  revokedAt: number | null;
}

function rowToUser(row: any): UserRecord {
  return {
    email: row.email,
    role: row.role,
    name: row.name ?? null,
    company: row.company ?? null,
    model_overrides: row.model_overrides ? JSON.parse(row.model_overrides) : {},
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? null,
  };
}

function rowToKey(row: any): ApiKeyRecord {
  return {
    id: row.id,
    keyHash: row.key_hash,
    name: row.name ?? null,
    alias: row.alias ?? null,
    email: row.email,
    revoked: !!row.revoked,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
  };
}

// ============================================================================
// IN-MEMORY CACHES
// ============================================================================

export const CACHE_TTL = 5 * 60 * 1000;
export const userProfileCache = new Map<string, { user: UserRecord; timestamp: number }>();
export const apiKeyCache = new Map<string, { keyRecord: ApiKeyRecord; timestamp: number }>();

export function loadUser(email: string): UserRecord | null {
  if (typeof email !== "string" || !email) return null;
  const normalized = email.toLowerCase();
  const cached = userProfileCache.get(normalized);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.user;

  const row = db.prepare("SELECT * FROM validated_users WHERE email = ?").get(normalized);
  if (!row) return null;
  const user = rowToUser(row);
  userProfileCache.set(normalized, { user, timestamp: Date.now() });
  return user;
}

export function validateApiKey(apiKey: string): ApiKeyRecord | null {
  const keyHash = createHash("sha256").update(apiKey.trim()).digest("hex");
  const cached = apiKeyCache.get(keyHash);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.keyRecord;

  const row = db
    .prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0")
    .get(keyHash);
  if (!row) return null;
  const keyRecord = rowToKey(row);
  apiKeyCache.set(keyHash, { keyRecord, timestamp: Date.now() });
  return keyRecord;
}

// ============================================================================
// USERS
// ============================================================================

/**
 * Promote every email in GATEWAY_ADMIN_EMAILS to admin. Called once at
 * startup from connectDB(). Also safe to call from elsewhere.
 *
 * Idempotent semantics (same as upsertGuestIfMissing's admin branch):
 *   - email not in DB → inserted as admin with approved_at = now
 *   - email is a guest → upgraded to admin
 *   - email is a user or admin → unchanged (never downgrade)
 */
export function promoteConfiguredAdmins(): void {
  const admins = adminEmailsFromEnv();
  if (admins.size === 0) return;
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO validated_users (email, role, created_at, approved_at)
       VALUES (?, 'admin', ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       role = CASE WHEN validated_users.role = 'guest' THEN 'admin' ELSE validated_users.role END,
       approved_at = COALESCE(validated_users.approved_at, excluded.approved_at)`,
  );
  for (const email of admins) {
    stmt.run(email, now, now);
    userProfileCache.delete(email);
  }
  console.log(`✅ promoted ${admins.size} admin email(s) from GATEWAY_ADMIN_EMAILS`);
}

/**
 * Parse GATEWAY_ADMIN_EMAILS into a lowercase Set. Empty/unset → empty set.
 * The env var is read on every call (not cached) so admin list changes
 * via `.env` edits take effect without a gateway restart.
 */
function adminEmailsFromEnv(): Set<string> {
  const raw = process.env.GATEWAY_ADMIN_EMAILS || "";
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@")),
  );
}

export function upsertGuestIfMissing(email: string): void {
  const e = email.toLowerCase();
  const admins = adminEmailsFromEnv();

  if (admins.has(e)) {
    // Email is on the configured admin list. Seed as admin on first sight;
    // upgrade an existing guest row; never downgrade an existing user/admin.
    // Idempotent either way.
    const now = Date.now();
    db.prepare(
      `INSERT INTO validated_users (email, role, created_at, approved_at)
         VALUES (?, 'admin', ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         role = CASE WHEN validated_users.role = 'guest' THEN 'admin' ELSE validated_users.role END,
         approved_at = COALESCE(validated_users.approved_at, excluded.approved_at)`,
    ).run(e, now, now);
    userProfileCache.delete(e);
    return;
  }

  db.prepare(
    `INSERT INTO validated_users (email, role, created_at)
     VALUES (?, 'guest', ?)
     ON CONFLICT(email) DO NOTHING`,
  ).run(e, Date.now());
}

export function setUserRole(email: string, role: string, asApproval = false): void {
  const e = email.toLowerCase();
  const now = Date.now();
  db.prepare(
    `INSERT INTO validated_users (email, role, created_at, approved_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET role = excluded.role${
       asApproval ? ", approved_at = excluded.approved_at" : ""
     }`,
  ).run(e, role, now, asApproval ? now : null);
  userProfileCache.delete(e);
}

export function updateUserProfile(
  email: string,
  updates: { name?: string; company?: string },
): void {
  const fields: string[] = [];
  const vals: any[] = [];
  if (updates.name !== undefined) { fields.push("name = ?"); vals.push(updates.name); }
  if (updates.company !== undefined) { fields.push("company = ?"); vals.push(updates.company); }
  if (!fields.length) return;
  vals.push(email.toLowerCase());
  db.prepare(`UPDATE validated_users SET ${fields.join(", ")} WHERE email = ?`).run(...vals);
  userProfileCache.delete(email.toLowerCase());
}

export function setUserModelOverrides(email: string, overrides: Record<string, string>): void {
  db.prepare("UPDATE validated_users SET model_overrides = ? WHERE email = ?").run(
    JSON.stringify(overrides),
    email.toLowerCase(),
  );
  userProfileCache.delete(email.toLowerCase());
}

export function getUserModelOverrides(email: string): Record<string, string> {
  const row = db
    .prepare("SELECT model_overrides FROM validated_users WHERE email = ?")
    .get(email.toLowerCase()) as { model_overrides: string | null } | undefined;
  if (!row?.model_overrides) return {};
  try { return JSON.parse(row.model_overrides); } catch { return {}; }
}

export function deleteUser(email: string): void {
  db.prepare("DELETE FROM validated_users WHERE email = ?").run(email.toLowerCase());
  userProfileCache.delete(email.toLowerCase());
}

export function listAllUsers(): UserRecord[] {
  const rows = db
    .prepare("SELECT * FROM validated_users ORDER BY created_at DESC")
    .all();
  return rows.map(rowToUser);
}

export function listGuests(): UserRecord[] {
  const rows = db
    .prepare("SELECT * FROM validated_users WHERE role = 'guest' ORDER BY created_at DESC")
    .all();
  return rows.map(rowToUser);
}

export function deleteAllGuests(): number {
  const res = db.prepare("DELETE FROM validated_users WHERE role = 'guest'").run();
  return Number(res.changes);
}

// ============================================================================
// API KEYS
// ============================================================================

export function createApiKey(params: {
  keyHash: string;
  name: string | null;
  alias: string | null;
  email: string;
}): { id: string; createdAt: number } {
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO api_keys (id, key_hash, name, alias, email, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  ).run(id, params.keyHash, params.name, params.alias, params.email.toLowerCase(), createdAt);
  return { id, createdAt };
}

export function listUserKeys(
  email: string,
  opts: { page: number; limit: number },
): { keys: ApiKeyRecord[]; total: number } {
  const e = email.toLowerCase();
  const offset = (opts.page - 1) * opts.limit;
  const rows = db
    .prepare(
      `SELECT * FROM api_keys
       WHERE email = ? AND revoked = 0
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(e, opts.limit, offset);
  const total = (db
    .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE email = ? AND revoked = 0")
    .get(e) as { n: number }).n;
  return { keys: rows.map(rowToKey), total };
}

export function listUserKeyHashes(email: string): string[] {
  const rows = db
    .prepare("SELECT key_hash FROM api_keys WHERE email = ? AND revoked = 0")
    .all(email.toLowerCase()) as { key_hash: string }[];
  return rows.map((r) => r.key_hash);
}

export function updateApiKeyMeta(
  id: string,
  email: string,
  updates: { name?: string | null; alias?: string | null },
): boolean {
  const fields: string[] = [];
  const vals: any[] = [];
  if (updates.name !== undefined) { fields.push("name = ?"); vals.push(updates.name); }
  if (updates.alias !== undefined) { fields.push("alias = ?"); vals.push(updates.alias); }
  if (!fields.length) return false;
  vals.push(id, email.toLowerCase());
  const res = db
    .prepare(`UPDATE api_keys SET ${fields.join(", ")} WHERE id = ? AND email = ?`)
    .run(...vals);
  return Number(res.changes) > 0;
}

export function revokeApiKey(id: string, email: string): boolean {
  const res = db
    .prepare(
      `UPDATE api_keys SET revoked = 1, revoked_at = ?
       WHERE id = ? AND email = ? AND revoked = 0`,
    )
    .run(Date.now(), id, email.toLowerCase());
  return Number(res.changes) > 0;
}

export function revokeAllKeysForEmail(email: string): void {
  db.prepare(
    `UPDATE api_keys SET revoked = 1, revoked_at = ?
     WHERE email = ? AND revoked = 0`,
  ).run(Date.now(), email.toLowerCase());
  apiKeyCache.clear();
}

export function revokeAllKeys(): number {
  const res = db
    .prepare(`UPDATE api_keys SET revoked = 1, revoked_at = ? WHERE revoked = 0`)
    .run(Date.now());
  apiKeyCache.clear();
  return Number(res.changes);
}

// ============================================================================
// OTPs
// ============================================================================

export function createOtp(email: string, code: string, ttlMs: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO otps (email, code, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  ).run(email.toLowerCase(), code, now + ttlMs, now);
}

/** Consume a valid unexpired OTP atomically. Returns true if matched & deleted. */
export function consumeOtp(email: string, code: string): boolean {
  const e = email.toLowerCase();
  const row = db
    .prepare(
      `SELECT id FROM otps WHERE email = ? AND code = ? AND expires_at > ? LIMIT 1`,
    )
    .get(e, code, Date.now()) as { id: number } | undefined;
  if (!row) return false;
  db.prepare("DELETE FROM otps WHERE id = ?").run(row.id);
  return true;
}

export function sweepExpiredOtpsAndSessions(): void {
  const now = Date.now();
  db.prepare("DELETE FROM otps WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM sessions WHERE expires <= ?").run(now);
}

// ============================================================================
// SESSIONS
// ============================================================================

export function createSession(sessionId: string, sessionJson: string, expiresMs: number): void {
  db.prepare(
    `INSERT INTO sessions (id, session, expires) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET session = excluded.session, expires = excluded.expires`,
  ).run(sessionId, sessionJson, expiresMs);
}

// ============================================================================
// PENDING ACCESS REQUESTS (maps to guest users)
// ============================================================================

export function listPendingRequests(): Array<{ email: string; createdAt: number }> {
  return listGuests().map((u) => ({ email: u.email, createdAt: u.createdAt }));
}

// ============================================================================
// ADMIN STATS (per-user request/token totals)
// ============================================================================

export function userUsageTotals(emails: string[]): Record<string, { requests: number; tokens: number }> {
  if (!emails.length) return {};
  const placeholders = emails.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT email, COUNT(*) AS requests, COALESCE(SUM(tokens), 0) AS tokens
       FROM usage_logs
       WHERE email IN (${placeholders})
       GROUP BY email`,
    )
    .all(...emails) as { email: string; requests: number; tokens: number }[];
  const out: Record<string, { requests: number; tokens: number }> = {};
  for (const r of rows) out[r.email.toLowerCase()] = { requests: r.requests, tokens: r.tokens };
  return out;
}

// ============================================================================
// TEAMS
// ============================================================================

export interface TeamRecord {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string;
  memberCount: number;
}

/** Deterministic ref_id used to tag plugin_chunks owned by a team. */
export function teamRefId(teamId: string): string {
  return `team:${teamId}`;
}

/** Deterministic ref_id used to tag plugin_chunks owned by a user's memories. */
export function userMemoryRefId(email: string): string {
  return `user:${email.toLowerCase()}`;
}

export function listTeams(): TeamRecord[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.created_at AS createdAt, t.created_by AS createdBy,
              (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS memberCount
         FROM teams t
        ORDER BY t.name`,
    )
    .all() as TeamRecord[];
  return rows;
}

export function createTeam(name: string, createdBy: string): TeamRecord {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Team name required");
  if (trimmed.length > 64) throw new Error("Team name too long (max 64)");
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO teams (id, name, created_at, created_by) VALUES (?, ?, ?, ?)`,
  ).run(id, trimmed, createdAt, createdBy.toLowerCase());
  return { id, name: trimmed, createdAt, createdBy: createdBy.toLowerCase(), memberCount: 0 };
}

/** Delete a team, its memberships, and its ref-overlay rows on plugin_chunks. */
export function deleteTeam(id: string): void {
  const ref = teamRefId(id);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM plugin_ref_chunks WHERE ref_id = ?").run(ref);
    db.prepare("DELETE FROM team_members WHERE team_id = ?").run(id);
    db.prepare("DELETE FROM teams WHERE id = ?").run(id);
  });
  tx();
}

export function getTeam(id: string): TeamRecord | null {
  const row = db
    .prepare(
      `SELECT t.id, t.name, t.created_at AS createdAt, t.created_by AS createdBy,
              (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS memberCount
         FROM teams t
        WHERE t.id = ?`,
    )
    .get(id) as TeamRecord | undefined;
  return row ?? null;
}

export function listTeamMembers(teamId: string): string[] {
  const rows = db
    .prepare(
      `SELECT email FROM team_members WHERE team_id = ? ORDER BY email`,
    )
    .all(teamId) as { email: string }[];
  return rows.map((r) => r.email);
}

export function addTeamMember(teamId: string, email: string): void {
  const e = email.toLowerCase();
  db.prepare(
    `INSERT OR IGNORE INTO team_members (team_id, email, added_at) VALUES (?, ?, ?)`,
  ).run(teamId, e, Date.now());
}

export function removeTeamMember(teamId: string, email: string): void {
  db.prepare("DELETE FROM team_members WHERE team_id = ? AND email = ?").run(
    teamId,
    email.toLowerCase(),
  );
}

export function listUserTeams(email: string): Array<{ id: string; name: string }> {
  const rows = db
    .prepare(
      `SELECT t.id, t.name
         FROM teams t
         JOIN team_members m ON m.team_id = t.id
        WHERE m.email = ?
        ORDER BY t.name`,
    )
    .all(email.toLowerCase()) as Array<{ id: string; name: string }>;
  return rows;
}

// ============================================================================
// CLI SECRET (localhost bypass for `litellmctl api`)
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

export async function getAuthenticatedUser(
  req: Request,
): Promise<{ email: string; role: string } | null> {
  const cliSecret = req.headers.get("x-gateway-secret");
  if (cliSecret && cliSecret === _cliSecret) {
    return { email: "cli@localhost", role: "admin" };
  }

  const apiKey = extractApiKey(req);
  if (apiKey) {
    const keyRecord = validateApiKey(apiKey);
    if (keyRecord) {
      const user = loadUser(keyRecord.email);
      return user ? { email: user.email, role: user.role } : null;
    }
    return null;
  }
  const sessionToken = getSessionCookie(req);
  if (!sessionToken) return null;
  const session = await verifySession(sessionToken);
  if (!session) return null;
  const sessionEmail = (session as { email?: unknown }).email;
  if (typeof sessionEmail !== "string" || !sessionEmail) return null;
  const user = loadUser(sessionEmail);
  return user ? { email: user.email, role: user.role } : null;
}

export async function requireAuth(req: Request): Promise<{ email: string; role: string } | Response> {
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  return user;
}

export async function requireUser(req: Request): Promise<{ email: string; role: string } | Response> {
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (user.role === "guest") return Response.json({ error: "User access required" }, { status: 403 });
  return user;
}

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

interface UsageRow {
  email: string;
  model: string;
  actualModel: string;
  requestedModel: string;
  endpoint: string | null;
  promptTokens: number;
  completionTokens: number;
  tokens: number;
  apiKeyHash: string | null;
  timestamp: number;
}

const _usageQueue: UsageRow[] = [];

export async function flushUsageQueue() {
  if (_usageQueue.length === 0) return;
  const batch = _usageQueue.splice(0, _usageQueue.length);
  try {
    const stmt = db.prepare(
      `INSERT INTO usage_logs
       (email, model, actual_model, requested_model, endpoint,
        prompt_tokens, completion_tokens, tokens, api_key_hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = db.transaction((rows: UsageRow[]) => {
      for (const r of rows) {
        stmt.run(
          r.email, r.model, r.actualModel, r.requestedModel, r.endpoint,
          r.promptTokens, r.completionTokens, r.tokens, r.apiKeyHash, r.timestamp,
        );
      }
    });
    tx(batch);
  } catch (err) {
    console.error("⚠️ Usage batch insert failed:", errorMessage(err));
  }
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
  _usageQueue.push({
    email,
    model,
    actualModel: model,
    requestedModel: requestedModel || model,
    endpoint: endpoint || null,
    promptTokens,
    completionTokens,
    tokens: promptTokens + completionTokens,
    apiKeyHash,
    timestamp: Date.now(),
  });
}
