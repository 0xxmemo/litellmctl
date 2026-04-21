/**
 * supermemory server plugin — owns /api/plugins/supermemory/*.
 *
 * Personal and team memory store backed by the shared sqlite-vec `memories`
 * collection. Per-user and per-team isolation is expressed via plugin_ref_chunks
 * overlays — on save we tag each chunk with `user:<email>`; on read we union
 * the caller's user ref with every team ref they belong to.
 */

import * as crypto from "node:crypto";
import {
  db,
  requireUser,
  listUserTeams,
  teamRefId,
  userMemoryRefId,
} from "../lib/db";
import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import {
  appendRefOverlay,
  createCollection,
  deleteByIds,
  hasCollection,
  insertDocuments,
  listExistingChunkIds,
  queryByFilter,
  searchVectors,
  type VectorDocument,
} from "../lib/vectordb";
import type { GatewayPlugin } from "../lib/plugin-registry";

// ── Constants ─────────────────────────────────────────────────────────────────

const COLLECTION = "memories";
const MEMORY_REF_FILE = "memory";
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

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

function memoryReadRefs(email: string): string[] {
  const refs = [userMemoryRefId(email)];
  for (const t of listUserTeams(email)) refs.push(teamRefId(t.id));
  return refs;
}

function ensureCollection(): void {
  if (!hasCollection(COLLECTION)) {
    createCollection(COLLECTION, EMBEDDING_DIMENSIONS);
  }
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${LITELLM_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: LITELLM_AUTH },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIMENSIONS }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`embed ${res.status}: ${msg}`);
  }
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

// ── Route handlers ────────────────────────────────────────────────────────────

// POST /api/plugins/supermemory/save
// Body: { content: string, id?: string, metadata?: Record<string, unknown> }
// Server embeds, inserts, and auto-tags with the caller's user ref.
async function handleSave(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: { content?: string; id?: string; metadata?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const content = body.content?.trim();
  if (!content) return errJson("content required");

  ensureCollection();

  const id = body.id ?? `mem_${crypto.createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
  const vector = await embed(content);

  const doc: VectorDocument = {
    id,
    vector,
    content,
    relativePath: MEMORY_REF_FILE,
    startLine: 0,
    endLine: 0,
    fileExtension: "",
    metadata: {
      source: body.metadata?.source ?? "api",
      createdAt: new Date().toISOString(),
      ...body.metadata,
    },
  };

  insertDocuments(COLLECTION, [doc]);
  appendRefOverlay(COLLECTION, userMemoryRefId(auth.email), MEMORY_REF_FILE, [id]);

  return Response.json({ id, status: "saved" });
}

// POST /api/plugins/supermemory/forget
// Body: { id?: string, content?: string }
// Deletes only chunks the caller owns (scoped to their user ref overlay).
async function handleForget(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: { id?: string; ids?: string[]; content?: string };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  let ids: string[] = [];
  if (body.id) ids = [body.id];
  else if (Array.isArray(body.ids)) ids = body.ids.filter((x): x is string => typeof x === "string");
  else if (body.content) {
    ids = [`mem_${crypto.createHash("sha256").update(body.content).digest("hex").slice(0, 16)}`];
  }
  if (ids.length === 0) return errJson("id, ids, or content required");

  if (!hasCollection(COLLECTION)) return Response.json({ deleted: 0 });

  // Restrict to chunks the caller actually owns (user-scoped, not team-scoped).
  ids = listExistingChunkIds(COLLECTION, ids);
  if (ids.length === 0) return Response.json({ deleted: 0 });

  const ownRef = userMemoryRefId(auth.email);
  const phs = placeholders(ids.length);
  const owned = db
    .prepare(
      `SELECT DISTINCT chunk_id FROM plugin_ref_chunks
        WHERE collection = ? AND ref_id = ? AND chunk_id IN (${phs})`,
    )
    .all(COLLECTION, ownRef, ...ids) as { chunk_id: string }[];
  const ownedIds = owned.map((r) => r.chunk_id);
  if (ownedIds.length === 0) return Response.json({ deleted: 0 });

  const res = deleteByIds(COLLECTION, ownedIds);
  return Response.json(res);
}

// POST /api/plugins/supermemory/search
// Body: { query: string, limit?: number }
// Auto-scopes to caller's user ref + every team ref they belong to.
async function handleSearch(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: { query?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  const query = body.query?.trim();
  if (!query) return errJson("query required");
  if (!hasCollection(COLLECTION)) return Response.json({ results: [] });

  const queryVector = await embed(query);
  const refs = memoryReadRefs(auth.email);
  const results = searchVectors(COLLECTION, queryVector, Math.min(body.limit ?? 10, 50), null, refs);

  return Response.json({
    results: results.map((r) => ({
      id: r.document.id,
      content: r.document.content,
      similarity: r.score,
      createdAt: (r.document.metadata as { createdAt?: string })?.createdAt ?? null,
    })),
  });
}

// GET /api/plugins/supermemory/usage — list recent memories for UI
async function handleUsage(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const coll = db
    .prepare(
      `SELECT dimension, created_at AS createdAt
         FROM plugin_collections WHERE name = ?`,
    )
    .get(COLLECTION) as { dimension: number; createdAt: number } | undefined;

  if (!coll) return Response.json({ exists: false, total: 0, memories: [] });

  const refs = memoryReadRefs(auth.email);
  const refPh = placeholders(refs.length);

  const { total } = db
    .prepare(
      `SELECT COUNT(DISTINCT pc.chunk_id) AS total
         FROM plugin_chunks pc
         JOIN plugin_ref_chunks prc
           ON prc.collection = pc.collection AND prc.chunk_id = pc.chunk_id
        WHERE pc.collection = ?
          AND prc.ref_id IN (${refPh})`,
    )
    .get(COLLECTION, ...refs) as { total: number };

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "20", 10)));

  const rows = db
    .prepare(
      `SELECT pc.chunk_id AS id, pc.content, pc.metadata, pc.rowid
         FROM plugin_chunks pc
         JOIN plugin_ref_chunks prc
           ON prc.collection = pc.collection AND prc.chunk_id = pc.chunk_id
        WHERE pc.collection = ?
          AND prc.ref_id IN (${refPh})
        GROUP BY pc.chunk_id
        ORDER BY pc.rowid DESC
        LIMIT ?`,
    )
    .all(COLLECTION, ...refs, limit) as Array<{
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

// ── Plugin definition ─────────────────────────────────────────────────────────

export const supermemoryPlugin: GatewayPlugin = {
  slug: "supermemory",
  name: "Supermemory",
  description: "Personal and team memory store.",
  routes: {
    "/save": { POST: handleSave },
    "/forget": { POST: handleForget },
    "/search": { POST: handleSearch },
    "/usage": { GET: handleUsage },
  },
};

// Suppress unused-import warning until needed by future endpoints.
void queryByFilter;
