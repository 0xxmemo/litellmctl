/**
 * Plugin usage / monitoring endpoints.
 *
 * These are separate from /api/plugins/* (manifest + install scripts) — they
 * return data about what each plugin has actually stored in the gateway's
 * sqlite-vec tables, so users can see activity in the Overview UI.
 *
 * Data model (v2, since `feat(vectordb): refactor for global shared
 * collections and branch-level isolation`):
 *   - `plugin_collections` and `plugin_chunks` are globally shared; there is
 *     no per-tenant column any more.
 *   - Per-user isolation is expressed via `plugin_ref_chunks` overlays:
 *       • memories: auto-tagged with `user:<email>` on insert, read side
 *         unions with `team:<id>` for every team the user belongs to.
 *       • claude-context: indexers declare their own branch-scoped ref ids;
 *         they are NOT tied to a specific gateway user, so code-chunk stats
 *         are reported globally (one row per `code_chunks_*` collection).
 */
import {
  db,
  listUserTeams,
  requireUser,
  teamRefId,
  userMemoryRefId,
} from "../lib/db";

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
//
// v2 collections are globally shared, so this endpoint reports the gateway-
// wide view of every `code_chunks_*` collection. Any authenticated user gets
// the same response — it reflects what has been indexed on this gateway,
// not "my API key".

async function claudeContextUsageHandler(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const collections = db
    .prepare(
      `SELECT name, dimension, created_at AS createdAt
         FROM plugin_collections
        WHERE name LIKE 'code_chunks_%'
        ORDER BY created_at DESC`,
    )
    .all() as Array<{ name: string; dimension: number; createdAt: number }>;

  const results = collections.map((c) => {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS chunks,
                COUNT(DISTINCT relative_path) AS files
           FROM plugin_chunks
          WHERE collection = ?`,
      )
      .get(c.name) as { chunks: number; files: number };

    const sample = db
      .prepare(
        `SELECT metadata
           FROM plugin_chunks
          WHERE collection = ?
          LIMIT 1`,
      )
      .get(c.name) as { metadata: string | null } | undefined;
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
//
// Scoped to the caller's own user ref plus every team ref they're a member of,
// mirroring how `handleSearch` auto-scopes reads on the `memories` collection.

async function supermemoryUsageHandler(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const coll = db
    .prepare(
      `SELECT dimension, created_at AS createdAt
         FROM plugin_collections
        WHERE name = 'memories'`,
    )
    .get() as { dimension: number; createdAt: number } | undefined;

  if (!coll) {
    return Response.json({ exists: false, total: 0, memories: [] });
  }

  const refs = [userMemoryRefId(auth.email), ...listUserTeams(auth.email).map((t) => teamRefId(t.id))];
  if (refs.length === 0) {
    return Response.json({
      exists: true,
      total: 0,
      createdAt: coll.createdAt,
      dimension: coll.dimension,
      memories: [],
    });
  }

  const refPh = placeholders(refs.length);

  const { total } = db
    .prepare(
      `SELECT COUNT(DISTINCT pc.chunk_id) AS total
         FROM plugin_chunks pc
         JOIN plugin_ref_chunks prc
           ON prc.collection = pc.collection AND prc.chunk_id = pc.chunk_id
        WHERE pc.collection = 'memories'
          AND prc.ref_id IN (${refPh})`,
    )
    .get(...refs) as { total: number };

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "20", 10)));

  const rows = db
    .prepare(
      `SELECT pc.chunk_id AS id, pc.content, pc.metadata, pc.rowid
         FROM plugin_chunks pc
         JOIN plugin_ref_chunks prc
           ON prc.collection = pc.collection AND prc.chunk_id = pc.chunk_id
        WHERE pc.collection = 'memories'
          AND prc.ref_id IN (${refPh})
        GROUP BY pc.chunk_id
        ORDER BY pc.rowid DESC
        LIMIT ?`,
    )
    .all(...refs, limit) as Array<{
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
