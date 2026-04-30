/**
 * docs-context server plugin — owns /api/plugins/docs-context/*.
 *
 * Parallel pipeline to claude-context: indexes documentation websites instead
 * of git repositories. The chunk store, ref-overlay machinery, FTS+vector
 * tables, and embedding model are all shared with the code pipeline (they're
 * content-agnostic). What's different here:
 *
 *   - codebase_id is `docs:<host>[/<path-prefix>]` instead of a git origin.
 *   - "branch" is always the static string `latest` — docs don't fork.
 *   - jobs live in plugin_docs_jobs, separate from plugin_indexing_jobs.
 *   - the file IO + chunk pipeline still runs on the client (see
 *     plugins/claude-context/src/tools/docs-context.ts) — these routes only
 *     own job state, chunk persistence, overlay management, and search.
 *
 * Hidden-codebases share plugin_hidden_codebases with the code plugin; the
 * `docs:` prefix on every codebase_id makes the namespaces disjoint.
 */

import { db, requireUser, requireAdmin } from "../lib/db";
import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import {
  createCollection,
  dropCollection,
  getRefOverlay,
  hasCollection,
  insertDocuments,
  listExistingChunkIds,
  searchHybrid,
  setRefOverlay,
  type RefOverlayEntry,
  type VectorDocument,
} from "../lib/vectordb";
import type { GatewayPlugin } from "../lib/plugin-registry";

// ── Constants ─────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "bedrock/titan-embed-v2";
const EMBEDDING_DIMENSIONS = 1024;
const STALE_JOB_MS = 120_000;
const DEFAULT_REF = "latest";

// ── Validation ────────────────────────────────────────────────────────────────

// A docs source id has the form `docs:<host>[/<prefix>]` — for example
// `docs:bun.sh/docs` or `docs:react.dev`. Distinct namespace from git origins
// (which the code plugin owns), so the docs plugin gets its own hides/jobs
// tables instead of borrowing the code plugin's.
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._:/-]{2,199}$/;
const REF_RE = /^[A-Za-z0-9_:.\/@-]{1,128}$/;
const URL_RE = /^https?:\/\/[a-z0-9._-]{1,255}(\/[A-Za-z0-9._~%/-]{0,2048})?$/i;

function isValidSourceId(s: unknown): s is string {
  return typeof s === "string" && SOURCE_ID_RE.test(s) && s.startsWith("docs:");
}

function isValidRef(s: unknown): s is string {
  return typeof s === "string" && REF_RE.test(s);
}

function isValidUrl(s: unknown): s is string {
  return typeof s === "string" && URL_RE.test(s);
}

function buildRefId(sourceId: string, ref: string): string {
  return `${sourceId}#${ref}`;
}

// Accept both `sourceId` (canonical) and the legacy `codebaseId` field name
// from JSON bodies. The shared client sync helper (sync.ts) still hard-codes
// `codebaseId` because that's what the code plugin's wire format uses, and
// renaming there would force a wire change on the code side. This bridge is
// the cost of keeping that constraint.
function readSourceId(body: any): string | undefined {
  return (body?.sourceId ?? body?.codebaseId) as string | undefined;
}

// Same bridge for URL params on GET/DELETE requests.
function readSourceIdFromUrl(url: URL): string | null {
  return url.searchParams.get("sourceId") ?? url.searchParams.get("codebaseId");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function errJson(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

async function embedQuery(text: string): Promise<number[]> {
  const res = await fetch(`${LITELLM_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: LITELLM_AUTH },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIMENSIONS }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Embedding failed: ${res.status} ${msg}`);
  }
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

function resolveCollection(sourceId: string): string | null {
  const row = db
    .prepare(
      "SELECT collection FROM plugin_docs_jobs WHERE source_id = ? LIMIT 1",
    )
    .get(sourceId) as { collection: string } | undefined;
  return row?.collection ?? null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DocsJob {
  source_id: string;
  ref: string;
  collection: string;
  base_url: string;
  status: "indexing" | "indexed" | "failed" | "cancelled";
  percentage: number;
  pages_total: number | null;
  pages_indexed: number | null;
  total_chunks: number | null;
  error: string | null;
  started_at: number;
  updated_at: number;
}

function reapIfStale(job: DocsJob): DocsJob {
  if (job.status !== "indexing") return job;
  const now = Date.now();
  if (now - job.updated_at <= STALE_JOB_MS) return job;
  const error = "heartbeat timeout";
  db.prepare(
    `UPDATE plugin_docs_jobs
        SET status = 'failed', error = ?, updated_at = ?
      WHERE source_id = ? AND ref = ?`,
  ).run(error, now, job.source_id, job.ref);
  return { ...job, status: "failed", error, updated_at: now };
}

function existingJobStatus(sourceId: string, ref: string): string | null {
  const row = db
    .prepare(
      "SELECT status FROM plugin_docs_jobs WHERE source_id = ? AND ref = ?",
    )
    .get(sourceId, ref) as { status: string } | undefined;
  return row?.status ?? null;
}

// ── Route handlers ────────────────────────────────────────────────────────────

// POST /jobs — upsert by (source_id, ref).
async function handleUpsertJob(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const sourceId = readSourceId(body);
  const ref = body.ref ?? DEFAULT_REF;
  const baseUrl = body.base_url ?? body.baseUrl;
  const { collection, status, percentage, error, pages_total, pages_indexed, total_chunks } = body;

  if (!isValidSourceId(sourceId)) return errJson("sourceId required ('docs:<host>[/<prefix>]')");
  if (!isValidRef(ref)) return errJson("invalid ref");
  if (!collection || typeof collection !== "string") return errJson("collection required");
  if (!status || !["indexing", "indexed", "failed"].includes(status)) {
    return errJson("status must be indexing | indexed | failed");
  }
  if (baseUrl !== undefined && !isValidUrl(baseUrl)) return errJson("invalid baseUrl");

  if (status === "indexing") {
    const current = existingJobStatus(sourceId as string, ref as string);
    if (current === "cancelled") {
      return Response.json({ error: "job_cancelled" }, { status: 409 });
    }
  }

  const now = Date.now();
  const pct = typeof percentage === "number" ? percentage : -1;
  db.prepare(`
    INSERT INTO plugin_docs_jobs
      (source_id, ref, collection, base_url, status, percentage,
       pages_total, pages_indexed, total_chunks, error, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, ref) DO UPDATE SET
      collection      = excluded.collection,
      status          = excluded.status,
      percentage      = CASE WHEN excluded.percentage < 0
                              THEN plugin_docs_jobs.percentage
                              ELSE excluded.percentage END,
      base_url        = COALESCE(excluded.base_url, plugin_docs_jobs.base_url),
      pages_total     = COALESCE(excluded.pages_total, plugin_docs_jobs.pages_total),
      pages_indexed   = COALESCE(excluded.pages_indexed, plugin_docs_jobs.pages_indexed),
      total_chunks    = COALESCE(excluded.total_chunks, plugin_docs_jobs.total_chunks),
      error           = excluded.error,
      updated_at      = excluded.updated_at
  `).run(
    sourceId,
    ref,
    collection,
    baseUrl ?? "",
    status,
    pct < 0 ? 0 : pct,
    pages_total ?? null,
    pages_indexed ?? null,
    total_chunks ?? null,
    error ?? null,
    now,
    now,
  );

  return Response.json({ ok: true });
}

// GET /jobs[?sourceId=X[&ref=Y]]
async function handleGetJobs(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const sourceId = readSourceIdFromUrl(url);
  const ref = url.searchParams.get("ref") ?? (sourceId ? DEFAULT_REF : null);

  if (sourceId && ref) {
    if (!isValidSourceId(sourceId)) return errJson("invalid sourceId");
    if (!isValidRef(ref)) return errJson("invalid ref");
    const job = db
      .prepare(
        "SELECT * FROM plugin_docs_jobs WHERE source_id = ? AND ref = ?",
      )
      .get(sourceId, ref) as DocsJob | undefined;
    if (!job) return Response.json({ status: "not_found" }, { status: 404 });
    return Response.json(reapIfStale(job));
  }

  const jobs = (db
    .prepare("SELECT * FROM plugin_docs_jobs ORDER BY updated_at DESC")
    .all() as DocsJob[]).map(reapIfStale);
  return Response.json({ jobs });
}

// DELETE /jobs?sourceId=X[&ref=Y] — admin only.
async function handleDeleteJob(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const sourceId = readSourceIdFromUrl(url);
  const ref = url.searchParams.get("ref");

  if (!isValidSourceId(sourceId)) return errJson("sourceId required");

  const existing = db
    .prepare(
      "SELECT collection FROM plugin_docs_jobs WHERE source_id = ? LIMIT 1",
    )
    .get(sourceId) as { collection: string } | undefined;
  if (!existing) return Response.json({ deleted: false }, { status: 404 });

  if (ref) {
    if (!isValidRef(ref)) return errJson("invalid ref");
    const tx = db.transaction(() => {
      db.prepare(
        "DELETE FROM plugin_ref_chunks WHERE collection = ? AND ref_id = ?",
      ).run(existing.collection, buildRefId(sourceId as string, ref));
      db.prepare(
        "DELETE FROM plugin_docs_jobs WHERE source_id = ? AND ref = ?",
      ).run(sourceId, ref);
    });
    tx();
    return Response.json({ deleted: true, scope: "ref" });
  }

  dropCollection(existing.collection);
  db.prepare("DELETE FROM plugin_docs_jobs WHERE source_id = ?").run(sourceId);
  return Response.json({ deleted: true, scope: "source" });
}

// POST /jobs/cancel — admin only. Body: { sourceId, ref? }.
async function handleCancelJob(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const sourceId = readSourceId(body);
  const ref = body.ref;
  if (!isValidSourceId(sourceId)) return errJson("sourceId required");
  if (ref !== undefined && !isValidRef(ref)) return errJson("invalid ref");

  const now = Date.now();
  const error = "stopped by admin";
  const result = ref
    ? db
        .prepare(
          `UPDATE plugin_docs_jobs
              SET status = 'cancelled', error = ?, updated_at = ?
            WHERE source_id = ? AND ref = ? AND status = 'indexing'`,
        )
        .run(error, now, sourceId, ref)
    : db
        .prepare(
          `UPDATE plugin_docs_jobs
              SET status = 'cancelled', error = ?, updated_at = ?
            WHERE source_id = ? AND status = 'indexing'`,
        )
        .run(error, now, sourceId);

  return Response.json({ cancelled: Number(result.changes) });
}

// POST /chunks
async function handleInsertChunks(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const sourceId = readSourceId(body);
  const documents = body.documents as VectorDocument[] | undefined;
  if (!isValidSourceId(sourceId)) return errJson("sourceId required");
  if (!Array.isArray(documents) || documents.length === 0) {
    return errJson("documents must be a non-empty array");
  }

  const collection = resolveCollection(sourceId as string);
  if (!collection) return errJson("no active indexing job for this sourceId; POST /jobs first", 409);

  const cancelled = db
    .prepare(
      `SELECT 1 FROM plugin_docs_jobs
        WHERE source_id = ? AND status = 'cancelled'
        LIMIT 1`,
    )
    .get(sourceId as string);
  if (cancelled) return errJson("job_cancelled", 409);

  const firstVecLen = documents[0].vector?.length ?? 0;
  if (firstVecLen === 0) return errJson("documents[0].vector is empty");

  if (!hasCollection(collection)) {
    createCollection(collection, firstVecLen);
  }

  const result = insertDocuments(collection, documents);
  return Response.json(result);
}

// POST /chunks/exists
async function handleChunksExists(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const sourceId = readSourceId(body);
  const chunkIds = body.chunkIds as string[] | undefined;
  if (!isValidSourceId(sourceId)) return errJson("sourceId required");
  if (!Array.isArray(chunkIds)) return errJson("chunkIds must be an array");

  const collection = resolveCollection(sourceId as string);
  if (!collection || !hasCollection(collection)) {
    return Response.json({ existing: [] });
  }

  const existing = listExistingChunkIds(collection, chunkIds.filter((s) => typeof s === "string"));
  return Response.json({ existing });
}

// POST /overlay
async function handleOverlay(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  // Accept `branch` as an alias for `ref` so the shared client helper (which
  // names this field `branch` for code-pipeline parity) works without a
  // dedicated docs payload shape.
  const sourceId = readSourceId(body);
  const entries = body.entries as RefOverlayEntry[] | undefined;
  const ref = body.ref ?? body.branch ?? DEFAULT_REF;
  if (!isValidSourceId(sourceId)) return errJson("sourceId required");
  if (!isValidRef(ref)) return errJson("invalid ref");
  if (!Array.isArray(entries)) return errJson("entries must be an array");

  const collection = resolveCollection(sourceId as string);
  if (!collection) return errJson("no active indexing job for this sourceId", 409);
  // Collections are created lazily on the first /chunks write. A sync that
  // produces zero chunks (every page reused a prior content hash, every page
  // was JS-rendered to an empty shell, etc.) reaches /overlay before any
  // /chunks call has fired — bootstrap the collection at the known embedding
  // dimension so the overlay row can be written. Subsequent /chunks calls
  // populate it; until then it stays empty (search returns no hits, which is
  // the correct outcome for "indexed but nothing to embed").
  if (!hasCollection(collection)) createCollection(collection, EMBEDDING_DIMENSIONS);

  const result = setRefOverlay(collection, buildRefId(sourceId as string, ref), entries);
  return Response.json(result);
}

// GET /overlay?sourceId=X[&ref=Y]
async function handleGetOverlay(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const sourceId = readSourceIdFromUrl(url);
  const ref = url.searchParams.get("ref") ?? url.searchParams.get("branch") ?? DEFAULT_REF;
  if (!isValidSourceId(sourceId)) return errJson("sourceId required");
  if (!isValidRef(ref)) return errJson("invalid ref");

  const row = db
    .prepare(
      "SELECT * FROM plugin_docs_jobs WHERE source_id = ? AND ref = ?",
    )
    .get(sourceId, ref) as DocsJob | undefined;
  if (!row) return Response.json({ status: "not_found" }, { status: 404 });

  const job = reapIfStale(row);
  const entries = hasCollection(job.collection)
    ? getRefOverlay(job.collection, buildRefId(sourceId as string, ref))
    : [];

  // headCommit is meaningless for docs but kept in the payload shape so the
  // shared client helper can deserialize the same envelope as the code flow.
  return Response.json({
    status: job.status,
    headCommit: null,
    entries,
  });
}

// POST /search
async function handleSearch(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const query = body.query as string | undefined;
  const limit = (body.limit as number) ?? 10;
  if (!query || typeof query !== "string") return errJson("query required");

  const refInputs: Array<{ sourceId: string; ref: string }> = [];
  if (Array.isArray(body.refs) && body.refs.length > 0) {
    for (const r of body.refs) {
      const sid = r.sourceId ?? r.codebaseId;
      if (!isValidSourceId(sid)) return errJson("invalid sourceId in refs");
      const refStr = r.ref ?? r.branch ?? DEFAULT_REF;
      if (!isValidRef(refStr)) return errJson("invalid ref in refs");
      refInputs.push({ sourceId: sid as string, ref: refStr });
    }
  } else if (readSourceId(body)) {
    const sid = readSourceId(body)!;
    if (!isValidSourceId(sid)) return errJson("sourceId required");
    const refStr = body.ref ?? body.branch ?? DEFAULT_REF;
    if (!isValidRef(refStr)) return errJson("invalid ref");
    refInputs.push({ sourceId: sid, ref: refStr });
  } else {
    // No specific docs source requested → fan out across every indexed docs
    // source the user can see. This is what makes search_docs(query) without
    // a url argument useful: ask once, hit every framework the user has
    // indexed in this gateway.
    const rows = db
      .prepare(
        "SELECT source_id AS sourceId, ref FROM plugin_docs_jobs WHERE status = 'indexed'",
      )
      .all() as Array<{ sourceId: string; ref: string }>;
    for (const r of rows) refInputs.push({ sourceId: r.sourceId, ref: r.ref });
    if (refInputs.length === 0) {
      return Response.json({ error: "not_indexed" }, { status: 404 });
    }
  }

  const resolved: Array<{ sourceId: string; ref: string; job: DocsJob }> = [];
  for (const ref of refInputs) {
    const row = db
      .prepare(
        "SELECT * FROM plugin_docs_jobs WHERE source_id = ? AND ref = ?",
      )
      .get(ref.sourceId, ref.ref) as DocsJob | undefined;
    if (!row) continue;
    const job = reapIfStale(row);
    if (!hasCollection(job.collection)) continue;
    resolved.push({ ...ref, job });
  }
  if (resolved.length === 0) {
    return Response.json({ error: "not_indexed" }, { status: 404 });
  }

  let queryVector: number[];
  try {
    queryVector = await embedQuery(query);
  } catch (err: any) {
    return Response.json({ error: `embedding_failed: ${err.message}` }, { status: 502 });
  }

  const perRefLimit = Math.min(limit, 50);
  const merged: Array<{ document: unknown; score: number; sourceId: string }> = [];
  let anyIndexing = false;
  for (const ref of resolved) {
    if (ref.job.status === "indexing") anyIndexing = true;
    const rows = searchHybrid(
      ref.job.collection,
      queryVector,
      query,
      perRefLimit,
      null,
      buildRefId(ref.sourceId, ref.ref),
    );
    for (const r of rows) merged.push({ ...r, sourceId: ref.sourceId });
  }
  merged.sort((a, b) => b.score - a.score);
  const results = merged.slice(0, perRefLimit);

  return Response.json({ results, indexing: anyIndexing });
}

// POST /hidden — admin only. Lives in its own `plugin_hidden_doc_sources`
// table; deliberately not shared with the code plugin's `plugin_hidden_codebases`
// — "codebase" is code-specific terminology and the docs side gets its own
// namespace to keep semantics clean.
async function handleHideSource(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const sourceId = readSourceId(body);
  if (!isValidSourceId(sourceId)) return errJson("sourceId required");

  db.prepare(
    `INSERT INTO plugin_hidden_doc_sources (source_id, hidden_at)
     VALUES (?, ?)
     ON CONFLICT(source_id) DO NOTHING`,
  ).run(sourceId, Date.now());

  return Response.json({ hidden: true });
}

async function handleUnhideSource(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const sourceId = readSourceIdFromUrl(url);
  if (!isValidSourceId(sourceId)) return errJson("sourceId required");

  db.prepare("DELETE FROM plugin_hidden_doc_sources WHERE source_id = ?").run(sourceId);
  return Response.json({ hidden: false });
}

function loadHiddenSourceIds(): Set<string> {
  const rows = db
    .prepare("SELECT source_id AS sourceId FROM plugin_hidden_doc_sources")
    .all() as Array<{ sourceId: string }>;
  return new Set(rows.map((r) => r.sourceId));
}

// GET /usage — aggregated UI view, parallel shape to claude-context's /usage.
async function handleUsage(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const isAdmin = auth.role === "admin";
  const hiddenIds = loadHiddenSourceIds();

  const rawJobs = db
    .prepare(
      `SELECT source_id AS sourceId, ref, collection, base_url AS baseUrl,
              status, percentage, error,
              pages_total AS pagesTotal, pages_indexed AS pagesIndexed,
              total_chunks AS totalChunks, started_at AS startedAt,
              updated_at AS updatedAt
         FROM plugin_docs_jobs
        ORDER BY updated_at DESC`,
    )
    .all() as Array<{
      sourceId: string;
      ref: string;
      collection: string;
      baseUrl: string;
      status: string;
      percentage: number;
      error: string | null;
      pagesTotal: number | null;
      pagesIndexed: number | null;
      totalChunks: number | null;
      startedAt: number;
      updatedAt: number;
    }>;

  const allJobs = rawJobs.map((j) => {
    if (j.status !== "indexing") return j;
    const reaped = reapIfStale({
      source_id: j.sourceId,
      ref: j.ref,
      collection: j.collection,
      base_url: j.baseUrl,
      status: j.status as DocsJob["status"],
      percentage: j.percentage,
      pages_total: j.pagesTotal,
      pages_indexed: j.pagesIndexed,
      total_chunks: j.totalChunks,
      error: j.error,
      started_at: j.startedAt,
      updated_at: j.updatedAt,
    });
    return {
      ...j,
      status: reaped.status,
      error: reaped.error,
      updatedAt: reaped.updated_at,
    };
  });

  const sources = allJobs
    .filter((j) => j.status === "indexed")
    .filter((j) => isAdmin || !hiddenIds.has(j.sourceId))
    .map((j) => {
      const counts = db
        .prepare(
          `SELECT COUNT(*) AS chunks, COUNT(DISTINCT relative_path) AS pages
             FROM plugin_chunks
            WHERE collection = ?`,
        )
        .get(j.collection) as { chunks: number; pages: number };
      return {
        sourceId: j.sourceId,
        baseUrl: j.baseUrl,
        ref: j.ref,
        collection: j.collection,
        pages: counts.pages,
        chunks: counts.chunks,
        updatedAt: j.updatedAt,
        hidden: hiddenIds.has(j.sourceId),
      };
    });

  const indexing = allJobs
    .filter(
      (j) => j.status === "indexing" || j.status === "failed" || j.status === "cancelled",
    )
    .filter((j) => isAdmin || !hiddenIds.has(j.sourceId))
    .map((j) => ({ ...j, hidden: hiddenIds.has(j.sourceId) }));

  const totals = {
    sources: sources.length,
    chunks: sources.reduce((sum, r) => sum + r.chunks, 0),
    pages: sources.reduce((sum, r) => sum + r.pages, 0),
  };

  return Response.json({ totals, sources, indexing });
}

// ── Plugin definition ─────────────────────────────────────────────────────────

export const docsContextPlugin: GatewayPlugin = {
  slug: "docs-context",
  name: "Docs Context",
  description: "Semantic documentation search — crawls + embeds doc sites alongside the code index.",
  routes: {
    "/jobs": { GET: handleGetJobs, POST: handleUpsertJob, DELETE: handleDeleteJob },
    "/jobs/cancel": { POST: handleCancelJob },
    "/chunks": { POST: handleInsertChunks },
    "/chunks/exists": { POST: handleChunksExists },
    "/overlay": { GET: handleGetOverlay, POST: handleOverlay },
    "/search": { POST: handleSearch },
    "/usage": { GET: handleUsage },
    "/hidden": { POST: handleHideSource, DELETE: handleUnhideSource },
  },
  migrate: () => {
    // The schema uses `source_id` (renamed from `codebase_id` — "codebase" is
    // code-specific terminology that doesn't fit a docs site). Drop the older
    // `codebase_id`-keyed table if it exists from an earlier dev rollout —
    // pre-prod, no migration script needed; users re-trigger indexing.
    const schemaCheck = db
      .prepare("PRAGMA table_info(plugin_docs_jobs)")
      .all() as Array<{ name: string }>;
    const hasOldSchema = schemaCheck.some((c) => c.name === "codebase_id");
    if (hasOldSchema) {
      db.run("DROP TABLE plugin_docs_jobs");
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS plugin_docs_jobs (
        source_id     TEXT NOT NULL,
        ref           TEXT NOT NULL DEFAULT 'latest',
        collection    TEXT NOT NULL,
        base_url      TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'indexing',
        percentage    REAL NOT NULL DEFAULT 0,
        pages_total   INTEGER,
        pages_indexed INTEGER,
        total_chunks  INTEGER,
        error         TEXT,
        started_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (source_id, ref)
      )
    `);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_plugin_docs_jobs_collection
         ON plugin_docs_jobs(collection)`,
    );

    // Hides live in their own table — "hidden_codebases" is code-specific, and
    // the docs side gets a clean docs-flavoured namespace.
    db.run(`
      CREATE TABLE IF NOT EXISTS plugin_hidden_doc_sources (
        source_id  TEXT PRIMARY KEY,
        hidden_at  INTEGER NOT NULL
      )
    `);
  },
};
