/**
 * Plugin usage / monitoring endpoints.
 *
 * These are separate from /api/plugins/* (manifest + install scripts) — they
 * return per-tenant data about what each plugin has actually stored in the
 * gateway's sqlite-vec tables, so users can see activity on their own API
 * key in the Overview UI.
 *
 * Scoping: requireUser + extractApiKey + validateApiKey → api_key_hash.
 */

import { db, requireUser } from "../lib/db";

/**
 * Resolve the set of api_key_hashes owned by the authenticated caller.
 * The UI uses session auth, so we scope by email across all of the user's
 * (non-revoked) API keys — each plugin keys data by api_key_hash, but from
 * the user's perspective everything under their email is "theirs".
 */
async function resolveKeyHashes(req: Request): Promise<string[] | Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const rows = db
    .prepare(
      `SELECT key_hash FROM api_keys WHERE email = ? AND revoked = 0`,
    )
    .all(auth.email.toLowerCase()) as Array<{ key_hash: string }>;
  return rows.map((r) => r.key_hash);
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return (v && typeof v === "object" ? v : fallback) as T;
  } catch {
    return fallback;
  }
}

// ── claude-context: list indexed codebases + chunk / file counts ────────────

async function claudeContextUsageHandler(req: Request): Promise<Response> {
  const hashes = await resolveKeyHashes(req);
  if (hashes instanceof Response) return hashes;
  if (hashes.length === 0) {
    return Response.json({ totals: { codebases: 0, chunks: 0, files: 0 }, collections: [] });
  }

  const hashPh = placeholders(hashes.length);
  const collections = db
    .prepare(
      `SELECT api_key_hash AS apiKeyHash, name, dimension, created_at AS createdAt
         FROM plugin_collections
        WHERE api_key_hash IN (${hashPh})
          AND name LIKE 'code_chunks_%'
        ORDER BY created_at DESC`,
    )
    .all(...hashes) as Array<{
    apiKeyHash: string;
    name: string;
    dimension: number;
    createdAt: number;
  }>;

  const results = collections.map((c) => {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS chunks,
                COUNT(DISTINCT relative_path) AS files
           FROM plugin_chunks
          WHERE api_key_hash = ? AND collection = ?`,
      )
      .get(c.apiKeyHash, c.name) as { chunks: number; files: number };

    const sample = db
      .prepare(
        `SELECT metadata, relative_path
           FROM plugin_chunks
          WHERE api_key_hash = ? AND collection = ?
          LIMIT 1`,
      )
      .get(c.apiKeyHash, c.name) as { metadata: string | null; relative_path: string } | undefined;
    const codebasePath = sample
      ? (safeJson<{ codebasePath?: string }>(sample.metadata, {}).codebasePath ?? null)
      : null;

    return {
      name: c.name,
      dimension: c.dimension,
      createdAt: c.createdAt,
      chunks: counts.chunks,
      files: counts.files,
      codebasePath,
    };
  });

  const totals = {
    codebases: results.length,
    chunks: results.reduce((sum, r) => sum + r.chunks, 0),
    files: results.reduce((sum, r) => sum + r.files, 0),
  };

  return Response.json({ totals, collections: results });
}

// ── supermemory: count + recent memories ────────────────────────────────────

async function supermemoryUsageHandler(req: Request): Promise<Response> {
  const hashes = await resolveKeyHashes(req);
  if (hashes instanceof Response) return hashes;
  if (hashes.length === 0) {
    return Response.json({ exists: false, total: 0, memories: [] });
  }

  const hashPh = placeholders(hashes.length);
  const coll = db
    .prepare(
      `SELECT MIN(dimension) AS dimension,
              MIN(created_at) AS createdAt
         FROM plugin_collections
        WHERE api_key_hash IN (${hashPh})
          AND name = 'memories'`,
    )
    .get(...hashes) as { dimension: number | null; createdAt: number | null } | undefined;

  if (!coll || coll.dimension === null) {
    return Response.json({ exists: false, total: 0, memories: [] });
  }

  const { total } = db
    .prepare(
      `SELECT COUNT(*) AS total
         FROM plugin_chunks
        WHERE api_key_hash IN (${hashPh})
          AND collection = 'memories'`,
    )
    .get(...hashes) as { total: number };

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "20", 10)));

  const rows = db
    .prepare(
      `SELECT chunk_id AS id, content, metadata, rowid
         FROM plugin_chunks
        WHERE api_key_hash IN (${hashPh})
          AND collection = 'memories'
        ORDER BY rowid DESC
        LIMIT ?`,
    )
    .all(...hashes, limit) as Array<{
    id: string;
    content: string;
    metadata: string | null;
    rowid: number;
  }>;

  const memories = rows.map((r) => {
    const meta = safeJson<{ createdAt?: string; source?: string }>(r.metadata, {});
    return {
      id: r.id,
      content: r.content,
      createdAt: meta.createdAt ?? null,
      source: meta.source ?? null,
    };
  });

  return Response.json({
    exists: true,
    total,
    createdAt: coll.createdAt,
    dimension: coll.dimension,
    memories,
  });
}

export const pluginStatsRoutes = {
  "/api/plugins/claude-context/usage": { GET: claudeContextUsageHandler },
  "/api/plugins/supermemory/usage": { GET: supermemoryUsageHandler },
};
