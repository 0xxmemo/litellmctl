/**
 * claude-context server plugin — owns /api/plugins/claude-context/*.
 *
 * File I/O, chunking, and embedding run in the client-side MCP plugin. These
 * routes are the single source of truth for indexing state (jobs) and serve
 * semantic search against the shared sqlite-vec store.
 */

import { db, requireUser } from "../lib/db";
import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import {
  createCollection,
  dropCollection,
  hasCollection,
  insertDocuments,
  searchVectors,
  type VectorDocument,
} from "../lib/vectordb";
import type { GatewayPlugin } from "../lib/plugin-registry";

// ── Constants ─────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "local/nomic-embed-text";
const EMBEDDING_DIMENSIONS = 512;

// ── Helpers ───────────────────────────────────────────────────────────────────

function errJson(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndexingJob {
  path: string;
  collection: string;
  status: "indexing" | "indexed" | "failed";
  percentage: number;
  error: string | null;
  total_files: number | null;
  indexed_files: number | null;
  total_chunks: number | null;
  started_at: number;
  updated_at: number;
}

// ── Route handlers ────────────────────────────────────────────────────────────

// POST /api/plugins/claude-context/jobs
// Upsert a job. Called by the MCP plugin on start, progress, and completion.
async function handleUpsertJob(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: Partial<IndexingJob>;
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const { path, collection, status, percentage, error, total_files, indexed_files, total_chunks } = body;
  if (!path || typeof path !== "string") return errJson("path required");
  if (!collection || typeof collection !== "string") return errJson("collection required");
  if (!status || !["indexing", "indexed", "failed"].includes(status)) {
    return errJson("status must be indexing | indexed | failed");
  }

  const now = Date.now();
  db.prepare(`
    INSERT INTO plugin_indexing_jobs
      (path, collection, status, percentage, error, total_files, indexed_files, total_chunks, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      collection      = excluded.collection,
      status          = excluded.status,
      percentage      = excluded.percentage,
      error           = excluded.error,
      total_files     = COALESCE(excluded.total_files, plugin_indexing_jobs.total_files),
      indexed_files   = COALESCE(excluded.indexed_files, plugin_indexing_jobs.indexed_files),
      total_chunks    = COALESCE(excluded.total_chunks, plugin_indexing_jobs.total_chunks),
      updated_at      = excluded.updated_at
  `).run(
    path,
    collection,
    status,
    percentage ?? 0,
    error ?? null,
    total_files ?? null,
    indexed_files ?? null,
    total_chunks ?? null,
    now,
    now,
  );

  return Response.json({ ok: true });
}

// GET /api/plugins/claude-context/jobs[?path=...]
async function handleGetJobs(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const path = url.searchParams.get("path");

  if (path) {
    const job = db
      .prepare("SELECT * FROM plugin_indexing_jobs WHERE path = ?")
      .get(path) as IndexingJob | undefined;
    if (!job) return Response.json({ status: "not_found" }, { status: 404 });
    return Response.json(job);
  }

  const jobs = db
    .prepare("SELECT * FROM plugin_indexing_jobs ORDER BY updated_at DESC")
    .all() as IndexingJob[];
  return Response.json({ jobs });
}

// DELETE /api/plugins/claude-context/jobs?path=...
// Drops the vectordb collection AND the job record in one call. The client
// never sees a collection name — identity is `path`.
async function handleDeleteJob(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) return errJson("path required");

  const existing = db
    .prepare("SELECT collection FROM plugin_indexing_jobs WHERE path = ?")
    .get(path) as { collection: string } | undefined;
  if (!existing) return Response.json({ deleted: false }, { status: 404 });

  dropCollection(existing.collection);
  db.prepare("DELETE FROM plugin_indexing_jobs WHERE path = ?").run(path);
  return Response.json({ deleted: true });
}

// POST /api/plugins/claude-context/chunks
// Body: { path, documents: VectorDocument[] }
// Resolves the collection from the job by path, auto-creates on first call,
// inserts the batch. Client-side MCP plugin never knows the collection name.
async function handleInsertChunks(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: { path?: string; documents?: VectorDocument[] };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const { path, documents } = body;
  if (!path || typeof path !== "string") return errJson("path required");
  if (!Array.isArray(documents) || documents.length === 0) {
    return errJson("documents must be a non-empty array");
  }

  const job = db
    .prepare("SELECT collection FROM plugin_indexing_jobs WHERE path = ?")
    .get(path) as { collection: string } | undefined;
  if (!job) return errJson("no active indexing job for this path; POST /jobs first", 409);

  const firstVecLen = documents[0].vector?.length ?? 0;
  if (firstVecLen === 0) return errJson("documents[0].vector is empty");

  if (!hasCollection(job.collection)) {
    createCollection(job.collection, firstVecLen);
  }

  const result = insertDocuments(job.collection, documents);
  return Response.json(result);
}

// POST /api/plugins/claude-context/search
// Gateway embeds the query and runs the vector lookup — one round-trip from the MCP tool.
async function handleSearch(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: { path?: string; query?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const { path, query, limit = 10 } = body;
  if (!path || typeof path !== "string") return errJson("path required");
  if (!query || typeof query !== "string") return errJson("query required");

  const job = db
    .prepare("SELECT collection, status FROM plugin_indexing_jobs WHERE path = ?")
    .get(path) as { collection: string; status: string } | undefined;

  if (!job) return Response.json({ error: "not_indexed" }, { status: 404 });
  if (!hasCollection(job.collection)) {
    return Response.json({ error: "collection_missing" }, { status: 404 });
  }

  let queryVector: number[];
  try {
    queryVector = await embedQuery(query);
  } catch (err: any) {
    return Response.json({ error: `embedding_failed: ${err.message}` }, { status: 502 });
  }

  const results = searchVectors(job.collection, queryVector, Math.min(limit, 50), null);
  const indexing = job.status === "indexing";

  return Response.json({ results, indexing });
}

// GET /api/plugins/claude-context/usage
// Aggregated view for the UI: indexed collections (with files/chunks) plus in-progress jobs.
async function handleUsage(req: Request): Promise<Response> {
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
        `SELECT COUNT(*) AS chunks, COUNT(DISTINCT relative_path) AS files
           FROM plugin_chunks
          WHERE collection = ?`,
      )
      .get(c.name) as { chunks: number; files: number };
    const sample = db
      .prepare(`SELECT metadata FROM plugin_chunks WHERE collection = ? LIMIT 1`)
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

  const indexing = db
    .prepare(
      `SELECT path, collection, status, percentage, error,
              total_files, indexed_files, total_chunks, updated_at AS updatedAt
         FROM plugin_indexing_jobs
        WHERE status IN ('indexing', 'failed')
        ORDER BY updated_at DESC`,
    )
    .all();

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
  description: "Semantic code search backed by shared sqlite-vec.",
  routes: {
    "/jobs": { GET: handleGetJobs, POST: handleUpsertJob, DELETE: handleDeleteJob },
    "/chunks": { POST: handleInsertChunks },
    "/search": { POST: handleSearch },
    "/usage": { GET: handleUsage },
  },
  migrate: () => {
    db.run(`
      CREATE TABLE IF NOT EXISTS plugin_indexing_jobs (
        path TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'indexing',
        percentage REAL NOT NULL DEFAULT 0,
        error TEXT,
        total_files INTEGER,
        indexed_files INTEGER,
        total_chunks INTEGER,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  },
};
