/**
 * supermemory server plugin — owns /api/plugins/supermemory/*.
 *
 * Personal and team memory store backed by the shared sqlite-vec `memories`
 * collection. Per-user and per-team isolation is expressed via plugin_ref_chunks
 * overlays — on save we tag each chunk with `user:<email>`; on read we union
 * the caller's user ref with every team ref they belong to.
 *
 * Project scoping rides on the chunk's metadata JSON (field: `project`).
 * vectordb's filter parser accepts `metadata.project in [...]` via json_extract,
 * which is how search/usage narrow to one or more named buckets. Default bucket
 * is "default"; slugs must match PROJECT_RE.
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
  dropCollection,
  hasCollection,
  insertDocuments,
  listExistingChunkIds,
  searchVectors,
  type VectorDocument,
} from "../lib/vectordb";
import type { GatewayPlugin } from "../lib/plugin-registry";

// ── Constants ─────────────────────────────────────────────────────────────────

const COLLECTION = "memories";
const MEMORY_REF_FILE = "memory";
const EMBEDDING_MODEL = "bedrock/titan-embed-v2";
const EMBEDDING_DIMENSIONS = 1024;

const DEFAULT_PROJECT = "default";
const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const MAX_CONTENT_LENGTH = 200_000;
const MAX_QUERY_LENGTH = 1_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function errJson(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function handleThrown(err: unknown): Response {
  if (err instanceof HttpError) return errJson(err.message, err.status);
  const msg = err instanceof Error ? err.message : String(err);
  return errJson(msg, 500);
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

function normalizeProject(raw: unknown): string {
  if (raw == null) return DEFAULT_PROJECT;
  if (typeof raw !== "string") {
    throw new HttpError("project must be a string");
  }
  const slug = raw.trim().toLowerCase();
  if (slug === "") return DEFAULT_PROJECT;
  if (!PROJECT_RE.test(slug)) {
    throw new HttpError(
      `invalid project slug: ${raw}. Must match /^[a-z0-9][a-z0-9._-]{0,63}$/`,
    );
  }
  return slug;
}

function normalizeProjectList(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new HttpError("projects must be an array");
  const out: string[] = [];
  for (const item of raw) out.push(normalizeProject(item));
  // de-dup while preserving order
  return Array.from(new Set(out));
}

function memoryId(project: string, content: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${project}\0${content}`)
    .digest("hex");
  return `mem_${hash.slice(0, 16)}`;
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${LITELLM_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: LITELLM_AUTH },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
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
// Body: { content: string, project?: string, id?: string, metadata?: object }
async function handleSave(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: {
    content?: string;
    project?: string;
    id?: string;
    metadata?: Record<string, unknown>;
  };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  try {
    const content = body.content?.trim();
    if (!content) return errJson("content required");
    if (content.length > MAX_CONTENT_LENGTH) {
      return errJson(
        `content exceeds max length of ${MAX_CONTENT_LENGTH} chars`,
      );
    }

    const project = normalizeProject(body.project);

    ensureCollection();

    const id = body.id ?? memoryId(project, content);
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
        project,
      },
    };

    insertDocuments(COLLECTION, [doc]);
    appendRefOverlay(
      COLLECTION,
      userMemoryRefId(auth.email),
      MEMORY_REF_FILE,
      [id],
    );

    return Response.json({ id, project, status: "saved" });
  } catch (err) {
    return handleThrown(err);
  }
}

// POST /api/plugins/supermemory/forget
// Body: { id?: string, ids?: string[], content?: string, project?: string }
async function handleForget(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: {
    id?: string;
    ids?: string[];
    content?: string;
    project?: string;
  };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  try {
    let ids: string[] = [];
    if (body.id) {
      ids = [body.id];
    } else if (Array.isArray(body.ids)) {
      ids = body.ids.filter((x): x is string => typeof x === "string");
    } else if (body.content) {
      const project = normalizeProject(body.project);
      ids = [memoryId(project, body.content)];
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
  } catch (err) {
    return handleThrown(err);
  }
}

// POST /api/plugins/supermemory/search
// Body: { query: string, limit?: number, project?: string, projects?: string[] }
async function handleSearch(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: {
    query?: string;
    limit?: number;
    project?: string;
    projects?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }

  try {
    const query = body.query?.trim();
    if (!query) return errJson("query required");
    if (query.length > MAX_QUERY_LENGTH) {
      return errJson(`query exceeds max length of ${MAX_QUERY_LENGTH} chars`);
    }
    if (!hasCollection(COLLECTION)) return Response.json({ results: [] });

    const projectList = Array.isArray(body.projects)
      ? normalizeProjectList(body.projects)
      : [normalizeProject(body.project)];

    // parseFilterExpr accepts `metadata.project in ["a","b"]`. Escape nothing —
    // we've already run each slug through PROJECT_RE which rejects quotes etc.
    const filterExpr = `metadata.project in [${projectList
      .map((p) => `"${p}"`)
      .join(",")}]`;

    const queryVector = await embed(query);
    const refs = memoryReadRefs(auth.email);
    const limit = Math.min(body.limit ?? 10, 50);
    const results = searchVectors(
      COLLECTION,
      queryVector,
      limit,
      filterExpr,
      refs,
    );

    return Response.json({
      results: results.map((r) => {
        const meta = (r.document.metadata ?? {}) as {
          createdAt?: string;
          project?: string;
        };
        return {
          id: r.document.id,
          content: r.document.content,
          similarity: r.score,
          project: meta.project ?? DEFAULT_PROJECT,
          createdAt: meta.createdAt ?? null,
        };
      }),
    });
  } catch (err) {
    return handleThrown(err);
  }
}

// GET /api/plugins/supermemory/usage?limit=20&project=foo
async function handleUsage(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const coll = db
      .prepare(
        `SELECT dimension, created_at AS createdAt
           FROM plugin_collections WHERE name = ?`,
      )
      .get(COLLECTION) as { dimension: number; createdAt: number } | undefined;

    if (!coll) {
      return Response.json({ exists: false, total: 0, memories: [] });
    }

    const refs = memoryReadRefs(auth.email);
    const refPh = placeholders(refs.length);

    const url = new URL(req.url);
    const limit = Math.max(
      1,
      Math.min(100, parseInt(url.searchParams.get("limit") || "20", 10)),
    );

    const rawProject = url.searchParams.get("project");
    const projectFilter = rawProject != null && rawProject !== ""
      ? normalizeProject(rawProject)
      : null;

    const projectClause = projectFilter !== null
      ? "AND json_extract(pc.metadata, '$.project') = ?"
      : "";

    const totalArgs: (string | number)[] = [COLLECTION, ...refs];
    if (projectFilter !== null) totalArgs.push(projectFilter);

    const { total } = db
      .prepare(
        `SELECT COUNT(DISTINCT pc.chunk_id) AS total
           FROM plugin_chunks pc
           JOIN plugin_ref_chunks prc
             ON prc.collection = pc.collection AND prc.chunk_id = pc.chunk_id
          WHERE pc.collection = ?
            AND prc.ref_id IN (${refPh})
            ${projectClause}`,
      )
      .get(...totalArgs) as { total: number };

    const listArgs: (string | number)[] = [COLLECTION, ...refs];
    if (projectFilter !== null) listArgs.push(projectFilter);
    listArgs.push(limit);

    const rows = db
      .prepare(
        `SELECT pc.chunk_id AS id, pc.content, pc.metadata, pc.rowid
           FROM plugin_chunks pc
           JOIN plugin_ref_chunks prc
             ON prc.collection = pc.collection AND prc.chunk_id = pc.chunk_id
          WHERE pc.collection = ?
            AND prc.ref_id IN (${refPh})
            ${projectClause}
          GROUP BY pc.chunk_id
          ORDER BY pc.rowid DESC
          LIMIT ?`,
      )
      .all(...listArgs) as Array<{
      id: string;
      content: string;
      metadata: string | null;
      rowid: number;
    }>;

    const memories = rows.map((r) => {
      const meta = safeJson<{
        createdAt?: string;
        source?: string;
        project?: string;
      }>(r.metadata, {});
      return {
        id: r.id,
        content: r.content,
        createdAt: meta.createdAt ?? null,
        source: meta.source ?? null,
        project: meta.project ?? DEFAULT_PROJECT,
      };
    });

    return Response.json({
      exists: true,
      total,
      createdAt: coll.createdAt,
      dimension: coll.dimension,
      project: projectFilter,
      memories,
    });
  } catch (err) {
    return handleThrown(err);
  }
}

// GET /api/plugins/supermemory/whoami
async function handleWhoami(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  return Response.json({
    email: auth.email,
    role: auth.role,
    teams: listUserTeams(auth.email),
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
    "/whoami": { GET: handleWhoami },
  },
  migrate: () => {
    // One-shot dim cutover: drop the existing collection if it was embedded
    // against the old model. Running at every start is cheap: once dim
    // matches, this becomes a no-op.
    const row = db
      .prepare("SELECT dimension FROM plugin_collections WHERE name = ?")
      .get(COLLECTION) as { dimension: number } | undefined;
    if (row && row.dimension !== EMBEDDING_DIMENSIONS) {
      dropCollection(COLLECTION);
      console.log(
        `[supermemory] dropped legacy '${COLLECTION}' collection (dimension ${row.dimension} → ${EMBEDDING_DIMENSIONS})`,
      );
    }
  },
};
