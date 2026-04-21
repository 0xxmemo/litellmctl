#!/usr/bin/env bun
/**
 * One-shot migration: MongoDB (old gateway storage) → SQLite (new).
 *
 * Usage:
 *   GATEWAY_MONGODB_URI="mongodb://localhost:27017" \
 *   bun run gateway/script/migrate-mongo-to-sqlite.ts [--force] [--db-name=llm-gateway]
 *
 * Reads the source URI from $GATEWAY_MONGODB_URI (or --mongo-uri=...).
 * Writes to the new SQLite DB at $GATEWAY_DB_PATH (or the gateway default).
 *
 * Refuses to run if the SQLite tables already contain data, unless --force
 * is passed. Does not drop Mongo data — the source DB is left untouched so
 * you can reverify / rerun.
 *
 * NOTE: `mongodb` is no longer a runtime dep of the gateway. Before running
 * this script, install it temporarily:
 *   cd gateway && bun add mongodb
 * And remove it afterward:
 *   cd gateway && bun remove mongodb
 */

import { randomUUID } from "crypto";
import { connectDB, db } from "../lib/db";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const force = argv.includes("--force");
const dbNameArg = argv.find((a) => a.startsWith("--db-name="));
const mongoUriArg = argv.find((a) => a.startsWith("--mongo-uri="));
const mongoUri =
  mongoUriArg?.split("=").slice(1).join("=") || process.env.GATEWAY_MONGODB_URI;
const dbName = dbNameArg?.split("=")[1] || "llm-gateway";

if (!mongoUri) {
  console.error("ERROR: Set GATEWAY_MONGODB_URI or pass --mongo-uri=...");
  process.exit(1);
}

// ── dynamic mongo import (dep is optional) ──────────────────────────────────
let MongoClient: any;
try {
  // @ts-expect-error - this dep is installed temporarily for the migration
  ({ MongoClient } = await import("mongodb"));
} catch {
  console.error(
    "ERROR: `mongodb` package not installed.\n" +
      "Install it temporarily:\n" +
      "  cd gateway && bun add mongodb\n" +
      "Rerun this script, then:\n" +
      "  cd gateway && bun remove mongodb",
  );
  process.exit(1);
}

// ── helpers ─────────────────────────────────────────────────────────────────
function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function tableEmpty(name: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as {
    n: number;
  };
  return row.n === 0;
}

function ensureEmpty(name: string) {
  if (!tableEmpty(name) && !force) {
    console.error(
      `ERROR: SQLite table '${name}' already has rows. Refusing to migrate.\n` +
        "Pass --force to overlay onto existing data (may create duplicates for usage_logs).",
    );
    process.exit(2);
  }
}

// ── connect both ────────────────────────────────────────────────────────────
await connectDB();

const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
await client.connect();
const mdb = client.db(dbName);
console.log(`✅ Mongo connected (${dbName})`);

// ── validated_users ─────────────────────────────────────────────────────────
ensureEmpty("validated_users");
{
  const src = mdb.collection("validated_users");
  const cursor = src.find({});
  const stmt = db.prepare(
    `INSERT INTO validated_users
       (email, role, name, company, model_overrides, created_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       role = excluded.role,
       name = excluded.name,
       company = excluded.company,
       model_overrides = excluded.model_overrides,
       approved_at = excluded.approved_at`,
  );
  let count = 0;
  for await (const u of cursor) {
    if (!u.email) continue;
    const mo = u.model_overrides ? JSON.stringify(u.model_overrides) : null;
    stmt.run(
      String(u.email).toLowerCase(),
      u.role || "guest",
      u.name ?? null,
      u.company ?? null,
      mo,
      toMs(u.createdAt) ?? Date.now(),
      toMs(u.approvedAt),
    );
    count++;
  }
  console.log(`  validated_users: ${count}`);
}

// ── api_keys ────────────────────────────────────────────────────────────────
ensureEmpty("api_keys");
{
  const src = mdb.collection("api_keys");
  const cursor = src.find({});
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO api_keys
       (id, key_hash, name, alias, email, revoked, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0,
    skipped = 0;
  for await (const k of cursor) {
    if (!k.keyHash || !k.email) {
      skipped++; // skip legacy bcrypt-only keys (no sha256 hash)
      continue;
    }
    stmt.run(
      randomUUID(),
      String(k.keyHash),
      k.name ?? null,
      k.alias ?? null,
      String(k.email).toLowerCase(),
      k.revoked ? 1 : 0,
      toMs(k.createdAt) ?? Date.now(),
      toMs(k.revokedAt),
    );
    count++;
  }
  console.log(
    `  api_keys: ${count}${skipped ? ` (skipped ${skipped} legacy bcrypt-only)` : ""}`,
  );
}

// ── otps ────────────────────────────────────────────────────────────────────
ensureEmpty("otps");
{
  const src = mdb.collection("otps");
  const cursor = src.find({});
  const stmt = db.prepare(
    `INSERT INTO otps (email, code, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  );
  let count = 0;
  for await (const o of cursor) {
    if (!o.email || !o.code || !o.expiresAt) continue;
    stmt.run(
      String(o.email).toLowerCase(),
      String(o.code),
      toMs(o.expiresAt)!,
      toMs(o.createdAt) ?? Date.now(),
    );
    count++;
  }
  console.log(`  otps: ${count}`);
}

// ── sessions ────────────────────────────────────────────────────────────────
ensureEmpty("sessions");
{
  const src = mdb.collection("sessions");
  const cursor = src.find({});
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO sessions (id, session, expires) VALUES (?, ?, ?)`,
  );
  let count = 0;
  for await (const s of cursor) {
    const id = s._id != null ? String(s._id) : null;
    if (!id || !s.session) continue;
    const expires = toMs(s.expires) ?? Date.now() + 86400000;
    const sessionStr =
      typeof s.session === "string" ? s.session : JSON.stringify(s.session);
    stmt.run(id, sessionStr, expires);
    count++;
  }
  console.log(`  sessions: ${count}`);
}

// ── usage_logs ──────────────────────────────────────────────────────────────
ensureEmpty("usage_logs");
{
  const src = mdb.collection("usage_logs");
  const cursor = src.find({});
  const stmt = db.prepare(
    `INSERT INTO usage_logs
       (email, model, actual_model, requested_model, endpoint,
        prompt_tokens, completion_tokens, tokens, api_key_hash, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((batch: any[]) => {
    for (const r of batch) stmt.run(...r);
  });

  let count = 0;
  let batch: any[] = [];
  const FLUSH = 1000;
  for await (const u of cursor) {
    if (!u.email) continue;
    const model = u.model || u.actualModel || "unknown";
    const prompt = Number(u.promptTokens ?? 0) || 0;
    const completion = Number(u.completionTokens ?? 0) || 0;
    const tokens =
      Number(u.tokens ?? u.totalTokens ?? prompt + completion) || 0;
    batch.push([
      String(u.email).toLowerCase(),
      model,
      u.actualModel ?? model,
      u.requestedModel ?? model,
      u.endpoint ?? null,
      prompt,
      completion,
      tokens,
      u.apiKeyHash ?? null,
      toMs(u.timestamp) ?? Date.now(),
    ]);
    if (batch.length >= FLUSH) {
      tx(batch);
      count += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    tx(batch);
    count += batch.length;
  }
  console.log(`  usage_logs: ${count}`);
}

// ── done ────────────────────────────────────────────────────────────────────
await client.close();
console.log("✅ Migration complete.");
console.log("Next steps:");
console.log("  1. Restart the gateway: litellmctl restart gateway");
console.log("  2. Verify: litellmctl users");
console.log("  3. Uninstall mongo dep: cd gateway && bun remove mongodb");
process.exit(0);
