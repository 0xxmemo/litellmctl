/**
 * claude-context server plugin — owns /api/plugins/claude-context/*.
 *
 * Identity model:
 *   - codebase_id  → stable across users/machines (normalized `git remote get-url origin`)
 *   - branch       → current git branch on the client
 *   - collection   → sha256-derived from codebase_id; shared across all branches
 *   - ref overlay  → one per (codebase_id, branch), backed by plugin_ref_chunks
 *
 * File I/O, chunking, and embedding run in the client-side MCP plugin. These
 * routes are the single source of truth for indexing state (jobs keyed on
 * codebase_id+branch) and serve semantic search, scoped to a branch via
 * searchVectors(..., refId="<codebaseId>#<branch>").
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

// ── Validation ────────────────────────────────────────────────────────────────

const CODEBASE_ID_RE = /^[a-z0-9][a-z0-9._/-]{2,199}$/;
const BRANCH_RE = /^[A-Za-z0-9_:.\/@-]{1,128}$/;

function isValidCodebaseId(s: unknown): s is string {
  return typeof s === "string" && CODEBASE_ID_RE.test(s);
}

function isValidBranch(s: unknown): s is string {
  return typeof s === "string" && BRANCH_RE.test(s);
}

function buildRefId(codebaseId: string, branch: string): string {
  return `${codebaseId}#${branch}`;
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

function resolveCollection(codebaseId: string): string | null {
  const row = db
    .prepare(
      "SELECT collection FROM plugin_indexing_jobs WHERE codebase_id = ? LIMIT 1",
    )
    .get(codebaseId) as { collection: string } | undefined;
  return row?.collection ?? null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndexingJob {
  codebase_id: string;
  branch: string;
  collection: string;
  status: "indexing" | "indexed" | "failed" | "cancelled";
  percentage: number;
  head_commit: string | null;
  error: string | null;
  total_files: number | null;
  indexed_files: number | null;
  total_chunks: number | null;
  started_at: number;
  updated_at: number;
}

// Any job stuck in "indexing" with no heartbeat for this long is assumed dead
// (client killed mid-run). Reaper flips it to "failed" lazily on read, so the
// next index attempt isn't blocked by a ghost.
const STALE_JOB_MS = 120_000;

function reapIfStale(job: IndexingJob): IndexingJob {
  if (job.status !== "indexing") return job;
  const now = Date.now();
  if (now - job.updated_at <= STALE_JOB_MS) return job;
  const error = "heartbeat timeout";
  db.prepare(
    `UPDATE plugin_indexing_jobs
        SET status = 'failed', error = ?, updated_at = ?
      WHERE codebase_id = ? AND branch = ?`,
  ).run(error, now, job.codebase_id, job.branch);
  return { ...job, status: "failed", error, updated_at: now };
}

// A job in "cancelled" status is sticky — an admin flipped it to stop work.
// The client's next /chunks POST will 409 and its runSync aborts. Heartbeat
// upserts that would move it back to "indexing" are rejected so the cancel
// doesn't race with a concurrent heartbeat.
function existingJobStatus(
  codebaseId: string,
  branch: string,
): string | null {
  const row = db
    .prepare(
      "SELECT status FROM plugin_indexing_jobs WHERE codebase_id = ? AND branch = ?",
    )
    .get(codebaseId, branch) as { status: string } | undefined;
  return row?.status ?? null;
}

// ── Route handlers ────────────────────────────────────────────────────────────

// POST /jobs — upsert by (codebase_id, branch).
async function handleUpsertJob(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: Partial<IndexingJob> & { codebaseId?: string };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const codebaseId = body.codebase_id ?? body.codebaseId;
  const { branch, collection, status, percentage, head_commit, error, total_files, indexed_files, total_chunks } = body;

  if (!isValidCodebaseId(codebaseId)) return errJson("codebaseId required (normalized remote URL)");
  if (!isValidBranch(branch)) return errJson("branch required");
  if (!collection || typeof collection !== "string") return errJson("collection required");
  if (!status || !["indexing", "indexed", "failed"].includes(status)) {
    return errJson("status must be indexing | indexed | failed");
  }

  // An admin-issued cancel is sticky: reject heartbeats that would resurrect
  // the job as "indexing". Let terminal statuses (indexed|failed) through so
  // the client's own error path can still record a final state if it raced.
  if (status === "indexing") {
    const current = existingJobStatus(codebaseId as string, branch as string);
    if (current === "cancelled") {
      return Response.json({ error: "job_cancelled" }, { status: 409 });
    }
  }

  const now = Date.now();
  // Heartbeat-only writes (e.g. `{ total_files }` mid-sync) must not reset
  // percentage. Distinguish "not sent" from "sent as 0" with a sentinel.
  const pct = typeof percentage === "number" ? percentage : -1;
  db.prepare(`
    INSERT INTO plugin_indexing_jobs
      (codebase_id, branch, collection, status, percentage, head_commit,
       error, total_files, indexed_files, total_chunks, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(codebase_id, branch) DO UPDATE SET
      collection      = excluded.collection,
      status          = excluded.status,
      percentage      = CASE WHEN excluded.percentage < 0
                              THEN plugin_indexing_jobs.percentage
                              ELSE excluded.percentage END,
      head_commit     = COALESCE(excluded.head_commit, plugin_indexing_jobs.head_commit),
      error           = excluded.error,
      total_files     = COALESCE(excluded.total_files, plugin_indexing_jobs.total_files),
      indexed_files   = COALESCE(excluded.indexed_files, plugin_indexing_jobs.indexed_files),
      total_chunks    = COALESCE(excluded.total_chunks, plugin_indexing_jobs.total_chunks),
      updated_at      = excluded.updated_at
  `).run(
    codebaseId,
    branch,
    collection,
    status,
    pct < 0 ? 0 : pct,
    head_commit ?? null,
    error ?? null,
    total_files ?? null,
    indexed_files ?? null,
    total_chunks ?? null,
    now,
    now,
  );

  return Response.json({ ok: true });
}

// GET /jobs[?codebaseId=X[&branch=Y]]
async function handleGetJobs(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const codebaseId = url.searchParams.get("codebaseId");
  const branch = url.searchParams.get("branch");

  if (codebaseId && branch) {
    if (!isValidCodebaseId(codebaseId)) return errJson("invalid codebaseId");
    if (!isValidBranch(branch)) return errJson("invalid branch");
    const job = db
      .prepare(
        "SELECT * FROM plugin_indexing_jobs WHERE codebase_id = ? AND branch = ?",
      )
      .get(codebaseId, branch) as IndexingJob | undefined;
    if (!job) return Response.json({ status: "not_found" }, { status: 404 });
    return Response.json(reapIfStale(job));
  }

  if (codebaseId) {
    if (!isValidCodebaseId(codebaseId)) return errJson("invalid codebaseId");
    const jobs = (db
      .prepare(
        "SELECT * FROM plugin_indexing_jobs WHERE codebase_id = ? ORDER BY updated_at DESC",
      )
      .all(codebaseId) as IndexingJob[]).map(reapIfStale);
    return Response.json({ jobs });
  }

  const jobs = (db
    .prepare("SELECT * FROM plugin_indexing_jobs ORDER BY updated_at DESC")
    .all() as IndexingJob[]).map(reapIfStale);
  return Response.json({ jobs });
}

// DELETE /jobs?codebaseId=X[&branch=Y] — admin only.
// With branch: delete that branch's job row + overlay only (chunks stay — other branches may share).
// Without branch: drop the whole collection (chunks + overlays + jobs).
async function handleDeleteJob(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const codebaseId = url.searchParams.get("codebaseId");
  const branch = url.searchParams.get("branch");

  if (!isValidCodebaseId(codebaseId)) return errJson("codebaseId required");

  const existing = db
    .prepare(
      "SELECT collection FROM plugin_indexing_jobs WHERE codebase_id = ? LIMIT 1",
    )
    .get(codebaseId) as { collection: string } | undefined;
  if (!existing) return Response.json({ deleted: false }, { status: 404 });

  if (branch) {
    if (!isValidBranch(branch)) return errJson("invalid branch");
    const tx = db.transaction(() => {
      db.prepare(
        "DELETE FROM plugin_ref_chunks WHERE collection = ? AND ref_id = ?",
      ).run(existing.collection, buildRefId(codebaseId as string, branch));
      db.prepare(
        "DELETE FROM plugin_indexing_jobs WHERE codebase_id = ? AND branch = ?",
      ).run(codebaseId, branch);
    });
    tx();
    return Response.json({ deleted: true, scope: "branch" });
  }

  dropCollection(existing.collection);
  db.prepare("DELETE FROM plugin_indexing_jobs WHERE codebase_id = ?").run(codebaseId);
  return Response.json({ deleted: true, scope: "codebase" });
}

// POST /jobs/cancel — admin only. Body: { codebaseId, branch? }.
// Flips matching indexing jobs to "cancelled"; the running client CLI aborts
// at its next /chunks POST (409) or heartbeat (409).
async function handleCancelJob(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  let body: { codebaseId?: string; branch?: string };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const { codebaseId, branch } = body;
  if (!isValidCodebaseId(codebaseId)) return errJson("codebaseId required");
  if (branch !== undefined && !isValidBranch(branch)) return errJson("invalid branch");

  const now = Date.now();
  const error = "stopped by admin";
  const result = branch
    ? db
        .prepare(
          `UPDATE plugin_indexing_jobs
              SET status = 'cancelled', error = ?, updated_at = ?
            WHERE codebase_id = ? AND branch = ? AND status = 'indexing'`,
        )
        .run(error, now, codebaseId, branch)
    : db
        .prepare(
          `UPDATE plugin_indexing_jobs
              SET status = 'cancelled', error = ?, updated_at = ?
            WHERE codebase_id = ? AND status = 'indexing'`,
        )
        .run(error, now, codebaseId);

  return Response.json({ cancelled: Number(result.changes) });
}

// POST /chunks — body: { codebaseId, documents: VectorDocument[] }
// Client pre-filters via /chunks/exists, then sends only the missing docs.
async function handleInsertChunks(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: { codebaseId?: string; documents?: VectorDocument[] };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const { codebaseId, documents } = body;
  if (!isValidCodebaseId(codebaseId)) return errJson("codebaseId required");
  if (!Array.isArray(documents) || documents.length === 0) {
    return errJson("documents must be a non-empty array");
  }

  const collection = resolveCollection(codebaseId as string);
  if (!collection) return errJson("no active indexing job for this codebaseId; POST /jobs first", 409);

  // Reject chunk uploads for cancelled jobs so the client's runSync aborts
  // at the next batch instead of continuing to grind through embeddings.
  const cancelled = db
    .prepare(
      `SELECT 1 FROM plugin_indexing_jobs
        WHERE codebase_id = ? AND status = 'cancelled'
        LIMIT 1`,
    )
    .get(codebaseId as string);
  if (cancelled) return errJson("job_cancelled", 409);

  const firstVecLen = documents[0].vector?.length ?? 0;
  if (firstVecLen === 0) return errJson("documents[0].vector is empty");

  if (!hasCollection(collection)) {
    createCollection(collection, firstVecLen);
  }

  const result = insertDocuments(collection, documents);
  return Response.json(result);
}

// POST /chunks/exists — body: { codebaseId, chunkIds: string[] }
// Returns the subset of chunkIds already stored. Client embeds only the missing ones.
async function handleChunksExists(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: { codebaseId?: string; chunkIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const { codebaseId, chunkIds } = body;
  if (!isValidCodebaseId(codebaseId)) return errJson("codebaseId required");
  if (!Array.isArray(chunkIds)) return errJson("chunkIds must be an array");

  const collection = resolveCollection(codebaseId as string);
  if (!collection || !hasCollection(collection)) {
    return Response.json({ existing: [] });
  }

  const existing = listExistingChunkIds(collection, chunkIds.filter((s) => typeof s === "string"));
  return Response.json({ existing });
}

// POST /overlay — body: { codebaseId, branch, entries: RefOverlayEntry[] }
// Atomically replaces the overlay for (codebase, branch). Files no longer in the
// working tree drop out of search results on the next call with this refId.
async function handleOverlay(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: { codebaseId?: string; branch?: string; entries?: RefOverlayEntry[] };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const { codebaseId, branch, entries } = body;
  if (!isValidCodebaseId(codebaseId)) return errJson("codebaseId required");
  if (!isValidBranch(branch)) return errJson("branch required");
  if (!Array.isArray(entries)) return errJson("entries must be an array");

  const collection = resolveCollection(codebaseId as string);
  if (!collection) return errJson("no active indexing job for this codebaseId", 409);
  if (!hasCollection(collection)) return errJson("collection does not exist", 409);

  const result = setRefOverlay(collection, buildRefId(codebaseId as string, branch as string), entries);
  return Response.json(result);
}

// POST /search — body: { codebaseId, branch, query, limit } OR
//                       { refs: [{codebaseId, branch}], query, limit }
// The refs[] shape fans out across multiple codebases (parent + submodules)
// and merges results by score. Legacy single-codebase shape still works.
async function handleSearch(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: {
    codebaseId?: string;
    branch?: string;
    query?: string;
    limit?: number;
    refs?: Array<{ codebaseId?: string; branch?: string }>;
  };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const { query, limit = 10 } = body;
  if (!query || typeof query !== "string") return errJson("query required");

  const refInputs: Array<{ codebaseId: string; branch: string }> = [];
  if (Array.isArray(body.refs) && body.refs.length > 0) {
    for (const r of body.refs) {
      if (!isValidCodebaseId(r.codebaseId)) return errJson("invalid codebaseId in refs");
      if (!isValidBranch(r.branch)) return errJson("invalid branch in refs");
      refInputs.push({ codebaseId: r.codebaseId as string, branch: r.branch as string });
    }
  } else {
    if (!isValidCodebaseId(body.codebaseId)) return errJson("codebaseId required");
    if (!isValidBranch(body.branch)) return errJson("branch required");
    refInputs.push({ codebaseId: body.codebaseId as string, branch: body.branch as string });
  }

  // Resolve each ref to a live job + collection. Refs with no job are silently
  // skipped when part of a multi-ref fanout; a single-ref request still 404s
  // to preserve the old contract the CLI hook relies on.
  const resolved: Array<{ codebaseId: string; branch: string; job: IndexingJob }> = [];
  for (const ref of refInputs) {
    const row = db
      .prepare(
        "SELECT * FROM plugin_indexing_jobs WHERE codebase_id = ? AND branch = ?",
      )
      .get(ref.codebaseId, ref.branch) as IndexingJob | undefined;
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
  const merged: Array<{ document: unknown; score: number }> = [];
  let anyIndexing = false;
  for (const ref of resolved) {
    if (ref.job.status === "indexing") anyIndexing = true;
    // Hybrid: vector KNN + BM25, fused via RRF. queryText goes to the
    // FTS5 side, queryVector to the vec0 side; score is the RRF sum, so
    // comparing across refs still works — same scale regardless of ref.
    const rows = searchHybrid(
      ref.job.collection,
      queryVector,
      query,
      perRefLimit,
      null,
      buildRefId(ref.codebaseId, ref.branch),
    );
    for (const r of rows) merged.push(r);
  }
  merged.sort((a, b) => b.score - a.score);
  const results = merged.slice(0, perRefLimit);

  return Response.json({ results, indexing: anyIndexing });
}

// GET /overlay?codebaseId=X&branch=Y — returns the full overlay (file_path,
// chunk_ids, file_hash) for this ref plus the current head_commit. Clients
// use this to skip re-reading unchanged files during incremental sync.
async function handleGetOverlay(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const codebaseId = url.searchParams.get("codebaseId");
  const branch = url.searchParams.get("branch");
  if (!isValidCodebaseId(codebaseId)) return errJson("codebaseId required");
  if (!isValidBranch(branch)) return errJson("branch required");

  const row = db
    .prepare(
      "SELECT * FROM plugin_indexing_jobs WHERE codebase_id = ? AND branch = ?",
    )
    .get(codebaseId, branch) as IndexingJob | undefined;
  if (!row) return Response.json({ status: "not_found" }, { status: 404 });

  const job = reapIfStale(row);
  const entries = hasCollection(job.collection)
    ? getRefOverlay(job.collection, buildRefId(codebaseId as string, branch as string))
    : [];

  return Response.json({
    status: job.status,
    headCommit: job.head_commit,
    entries,
  });
}

// POST /hidden — admin only. Body: { codebaseId }. Marks a codebase as hidden
// so non-admin users don't see it in /usage. Purely a display filter — does
// not affect chunk storage, search, or indexing in any way.
async function handleHideCodebase(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  let body: { codebaseId?: string };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const { codebaseId } = body;
  if (!isValidCodebaseId(codebaseId)) return errJson("codebaseId required");

  db.prepare(
    `INSERT INTO plugin_hidden_codebases (codebase_id, hidden_at)
     VALUES (?, ?)
     ON CONFLICT(codebase_id) DO NOTHING`,
  ).run(codebaseId, Date.now());

  return Response.json({ hidden: true });
}

// DELETE /hidden?codebaseId=X — admin only. Removes the hidden flag.
async function handleUnhideCodebase(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const codebaseId = url.searchParams.get("codebaseId");
  if (!isValidCodebaseId(codebaseId)) return errJson("codebaseId required");

  db.prepare("DELETE FROM plugin_hidden_codebases WHERE codebase_id = ?").run(codebaseId);
  return Response.json({ hidden: false });
}

function loadHiddenCodebaseIds(): Set<string> {
  const rows = db
    .prepare("SELECT codebase_id AS codebaseId FROM plugin_hidden_codebases")
    .all() as Array<{ codebaseId: string }>;
  return new Set(rows.map((r) => r.codebaseId));
}

// GET /usage — aggregated view for the UI, one row per codebase with per-branch detail.
async function handleUsage(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const isAdmin = auth.role === "admin";
  const hiddenIds = loadHiddenCodebaseIds();

  const collections = db
    .prepare(
      `SELECT name, dimension, created_at AS createdAt
         FROM plugin_collections
        WHERE name LIKE 'code_chunks_%'
        ORDER BY created_at DESC`,
    )
    .all() as Array<{ name: string; dimension: number; createdAt: number }>;

  const rawJobs = db
    .prepare(
      `SELECT codebase_id AS codebaseId, branch, collection, status, percentage,
              head_commit AS headCommit, error,
              total_files AS totalFiles, indexed_files AS indexedFiles,
              total_chunks AS totalChunks, updated_at AS updatedAt
         FROM plugin_indexing_jobs
        ORDER BY updated_at DESC`,
    )
    .all() as Array<{
      codebaseId: string;
      branch: string;
      collection: string;
      status: string;
      percentage: number;
      headCommit: string | null;
      error: string | null;
      totalFiles: number | null;
      indexedFiles: number | null;
      totalChunks: number | null;
      updatedAt: number;
    }>;

  // Apply the staleness reaper so the UI doesn't keep showing "indexing" for
  // jobs whose client died without flipping the status. reapIfStale writes
  // back to the DB if it fires, so subsequent reads see the failed state.
  const allJobs = rawJobs.map((j) => {
    if (j.status !== "indexing") return j;
    const reaped = reapIfStale({
      codebase_id: j.codebaseId,
      branch: j.branch,
      collection: j.collection,
      status: j.status as IndexingJob["status"],
      percentage: j.percentage,
      head_commit: j.headCommit,
      error: j.error,
      total_files: j.totalFiles,
      indexed_files: j.indexedFiles,
      total_chunks: j.totalChunks,
      started_at: j.updatedAt,
      updated_at: j.updatedAt,
    });
    return {
      ...j,
      status: reaped.status,
      error: reaped.error,
      updatedAt: reaped.updated_at,
    };
  });

  const byCollection = new Map<string, typeof allJobs>();
  for (const j of allJobs) {
    if (!byCollection.has(j.collection)) byCollection.set(j.collection, []);
    byCollection.get(j.collection)!.push(j);
  }

  // Skip collections with no surviving job rows — those are orphan chunk sets
  // left behind by a Clear. They're still reusable on the next index_codebase
  // (chunk IDs are content-hashed, so chunksExists picks them back up), but
  // the UI shouldn't render rows without a codebaseId label.
  const results = collections
    .map((c) => {
      const jobs = byCollection.get(c.name) ?? [];
      const codebaseId = jobs[0]?.codebaseId ?? null;
      if (!codebaseId) return null;
      const hidden = hiddenIds.has(codebaseId);
      // Non-admins never see hidden codebases — this is a display filter only,
      // underlying chunks/search/indexing are untouched.
      if (hidden && !isAdmin) return null;
      const counts = db
        .prepare(
          `SELECT COUNT(*) AS chunks, COUNT(DISTINCT relative_path) AS files
             FROM plugin_chunks
            WHERE collection = ?`,
        )
        .get(c.name) as { chunks: number; files: number };
      return {
        name: c.name,
        codebaseId,
        dimension: c.dimension,
        createdAt: c.createdAt,
        chunks: counts.chunks,
        files: counts.files,
        hidden,
        branches: jobs.map((j) => ({
          branch: j.branch,
          status: j.status,
          percentage: j.percentage,
          headCommit: j.headCommit,
          totalFiles: j.totalFiles,
          indexedFiles: j.indexedFiles,
          totalChunks: j.totalChunks,
          updatedAt: j.updatedAt,
        })),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const indexing = allJobs
    .filter(
      (j) => j.status === "indexing" || j.status === "failed" || j.status === "cancelled",
    )
    .filter((j) => isAdmin || !hiddenIds.has(j.codebaseId))
    .map((j) => ({ ...j, hidden: hiddenIds.has(j.codebaseId) }));

  const totals = {
    codebases: results.length,
    chunks: results.reduce((sum, r) => sum + r.chunks, 0),
    files: results.reduce((sum, r) => sum + r.files, 0),
  };

  return Response.json({ totals, collections: results, indexing });
}

// ── Plugin definition ─────────────────────────────────────────────────────────

export const claudeContextPlugin: GatewayPlugin = {
  slug: "claude-context",
  name: "Claude Context",
  description: "Semantic code search backed by shared sqlite-vec, branch-aware via ref overlays.",
  routes: {
    "/jobs": { GET: handleGetJobs, POST: handleUpsertJob, DELETE: handleDeleteJob },
    "/jobs/cancel": { POST: handleCancelJob },
    "/chunks": { POST: handleInsertChunks },
    "/chunks/exists": { POST: handleChunksExists },
    "/overlay": { GET: handleGetOverlay, POST: handleOverlay },
    "/search": { POST: handleSearch },
    "/usage": { GET: handleUsage },
    "/hidden": { POST: handleHideCodebase, DELETE: handleUnhideCodebase },
  },
  migrate: () => {
    db.run(`
      CREATE TABLE IF NOT EXISTS plugin_indexing_jobs (
        codebase_id   TEXT NOT NULL,
        branch        TEXT NOT NULL,
        collection    TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'indexing',
        percentage    REAL NOT NULL DEFAULT 0,
        head_commit   TEXT,
        error         TEXT,
        total_files   INTEGER,
        indexed_files INTEGER,
        total_chunks  INTEGER,
        started_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (codebase_id, branch)
      )
    `);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_plugin_indexing_jobs_collection
         ON plugin_indexing_jobs(collection)`,
    );

    db.run(`
      CREATE TABLE IF NOT EXISTS plugin_hidden_codebases (
        codebase_id TEXT PRIMARY KEY,
        hidden_at   INTEGER NOT NULL
      )
    `);

    // One-shot cleanup: previous installs embedded at 512-d using a local
    // model. After the switch to bedrock/titan-embed-v2 @ 1024-d those chunks
    // are dead weight — vector searches can't mix dimensions and the local
    // embedder is gone, so they'll never be searched again. Drop every
    // collection whose dimension != EMBEDDING_DIMENSIONS along with its jobs.
    const stale = db
      .prepare(
        "SELECT name FROM plugin_collections WHERE name LIKE 'code_chunks_%' AND dimension != ?",
      )
      .all(EMBEDDING_DIMENSIONS) as Array<{ name: string }>;
    for (const { name } of stale) {
      dropCollection(name);
      db.prepare("DELETE FROM plugin_indexing_jobs WHERE collection = ?").run(name);
    }
    if (stale.length > 0) {
      console.log(
        `[claude-context] dropped ${stale.length} legacy collection(s) with dimension != ${EMBEDDING_DIMENSIONS}`,
      );
    }
  },
};
