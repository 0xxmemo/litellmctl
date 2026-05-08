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

/**
 * Stable chunk id keyed on (saver email, content). Project does NOT enter the
 * hash — the chunk lives once even when it surfaces in multiple project
 * buckets via a `projects: string[]` metadata array. Re-saving the same
 * content by the same user is therefore an upsert (merge projects, append any
 * new team refs, skip the embedding call).
 */
function memoryId(email: string, content: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${email.toLowerCase()}\0${content}`)
    .digest("hex");
  return `mem_${hash.slice(0, 16)}`;
}

interface ExistingChunk {
  rowid: number;
  metadata: Record<string, unknown>;
}

function readChunk(id: string): ExistingChunk | null {
  const row = db
    .prepare(
      `SELECT rowid, metadata FROM plugin_chunks
        WHERE collection = ? AND chunk_id = ?`,
    )
    .get(COLLECTION, id) as { rowid: number; metadata: string | null } | undefined;
  if (!row) return null;
  return { rowid: row.rowid, metadata: safeJson(row.metadata, {}) };
}

function writeChunkMetadata(id: string, metadata: Record<string, unknown>): void {
  db.prepare(
    `UPDATE plugin_chunks SET metadata = ?
      WHERE collection = ? AND chunk_id = ?`,
  ).run(JSON.stringify(metadata), COLLECTION, id);
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
// Body: {
//   content,
//   project?,  projects?,    // single + list, merged into metadata.projects[]
//   team?,     teams?,       // single + list, validated against listUserTeams
//   id?, metadata?
// }
//
// Memory model (post-collapse): each saved fact is a SINGLE chunk per
// (saver email, content). The chunk surfaces in multiple project buckets via
// `metadata.projects: string[]` and is shared with multiple teams via
// additional ref-overlay tags. Re-saving the same content by the same user
// is an upsert: union the projects array, append any new team refs, and SKIP
// the embedding call entirely. No data duplication, no double-embedding.
async function handleSave(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: {
    content?: string;
    project?: string;
    projects?: string[];
    team?: string;
    teams?: string[];
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

    // Project destinations: union of `project` + `projects[]`. Empty input
    // means "default" (one bucket). Slugs are normalized + deduped.
    const projectInputs: string[] = [];
    if (body.project !== undefined) projectInputs.push(normalizeProject(body.project));
    if (body.projects !== undefined) {
      projectInputs.push(...normalizeProjectList(body.projects));
    }
    let requestedProjects = Array.from(new Set(projectInputs));
    if (requestedProjects.length === 0) requestedProjects = [DEFAULT_PROJECT];

    // Team destinations: validate against the caller's membership.
    const teamInputs = new Set<string>();
    if (typeof body.team === "string" && body.team.trim()) {
      teamInputs.add(body.team.trim());
    }
    if (Array.isArray(body.teams)) {
      for (const t of body.teams) {
        if (typeof t === "string" && t.trim()) teamInputs.add(t.trim());
      }
    }
    let validatedTeamIds: string[] = [];
    if (teamInputs.size > 0) {
      const memberOf = new Set(listUserTeams(auth.email).map((t) => t.id));
      for (const id of teamInputs) {
        if (!memberOf.has(id)) {
          return errJson(
            `not a member of team ${id} (or team does not exist)`,
            403,
          );
        }
      }
      validatedTeamIds = Array.from(teamInputs);
    }

    ensureCollection();

    const id = body.id ?? memoryId(auth.email, content);

    const existing = readChunk(id);
    let projectsAfter: string[];
    if (existing) {
      // Upsert path — same content already stored. Union projects in place;
      // do not call embed(), do not touch the vector table.
      const prevProjects = Array.isArray(existing.metadata.projects)
        ? (existing.metadata.projects as unknown[]).filter(
            (p): p is string => typeof p === "string",
          )
        : typeof existing.metadata.project === "string"
          ? [existing.metadata.project]
          : [];
      projectsAfter = Array.from(
        new Set([...prevProjects, ...requestedProjects]),
      ).sort();

      const mergedMetadata: Record<string, unknown> = {
        ...existing.metadata,
        ...body.metadata,
        projects: projectsAfter,
        // Drop the legacy singular field — `projects` is canonical now.
      };
      delete (mergedMetadata as Record<string, unknown>).project;
      writeChunkMetadata(id, mergedMetadata);
    } else {
      // Fresh chunk — embed once, insert once.
      projectsAfter = [...requestedProjects].sort();
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
          projects: projectsAfter,
        },
      };
      insertDocuments(COLLECTION, [doc]);
    }

    // Ref overlays. appendRefOverlay is INSERT OR IGNORE — already-attached
    // refs are no-ops.
    appendRefOverlay(
      COLLECTION,
      userMemoryRefId(auth.email),
      MEMORY_REF_FILE,
      [id],
    );
    for (const teamId of validatedTeamIds) {
      appendRefOverlay(COLLECTION, teamRefId(teamId), MEMORY_REF_FILE, [id]);
    }

    return Response.json({
      id,
      projects: projectsAfter,
      teams: validatedTeamIds,
      reused: existing !== null,
      status: "saved",
    });
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

    // Ref-counted forget. A chunk may be referenced by:
    //   - the caller's own user ref (always — that's how we got here)
    //   - other users' user refs (a teammate co-saved the same content)
    //   - one or more team refs (the chunk is shared into team buckets)
    //
    // Rules:
    //   1. Always drop the caller's user-ref overlay row for ownedIds.
    //   2. For each chunk, drop any team-ref overlay rows where the caller
    //      is a current member (their contribution to that team).
    //   3. If, after (1)+(2), the chunk still has any other user-ref or
    //      team-ref overlay row, leave the underlying chunk intact —
    //      another user/team still wants it. Otherwise call deleteByIds
    //      to remove the chunk + its remaining overlay rows entirely.
    const ownedPhs = placeholders(ownedIds.length);
    const callerTeamIds = listUserTeams(auth.email).map((t) => t.id);
    const callerTeamRefs = callerTeamIds.map((id) => teamRefId(id));

    const tx = db.transaction(() => {
      // 1. Drop caller's user-ref overlay.
      db.prepare(
        `DELETE FROM plugin_ref_chunks
          WHERE collection = ? AND ref_id = ? AND chunk_id IN (${ownedPhs})`,
      ).run(COLLECTION, ownRef, ...ownedIds);

      // 2. Drop the caller's team-ref overlays for these chunks.
      if (callerTeamRefs.length > 0) {
        const teamPhs = placeholders(callerTeamRefs.length);
        db.prepare(
          `DELETE FROM plugin_ref_chunks
            WHERE collection = ?
              AND ref_id IN (${teamPhs})
              AND chunk_id IN (${ownedPhs})`,
        ).run(COLLECTION, ...callerTeamRefs, ...ownedIds);
      }
    });
    tx();

    // 3. Identify chunks that no overlay still references, and nuke them.
    const survivors = db
      .prepare(
        `SELECT DISTINCT chunk_id FROM plugin_ref_chunks
          WHERE collection = ? AND chunk_id IN (${ownedPhs})`,
      )
      .all(COLLECTION, ...ownedIds) as { chunk_id: string }[];
    const survivorIds = new Set(survivors.map((r) => r.chunk_id));
    const orphaned = ownedIds.filter((id) => !survivorIds.has(id));

    let deleted = 0;
    if (orphaned.length > 0) {
      const res = deleteByIds(COLLECTION, orphaned);
      deleted = res.deleted;
    }
    return Response.json({ deleted });
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

    // Chunks now store their bucket(s) in metadata.projects (string[]).
    // Match if ANY of the requested projects appear in the chunk's array.
    // Slugs went through PROJECT_RE so quote escaping isn't needed.
    const filterExpr = `metadata.projects[] in [${projectList
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
          projects?: unknown;
        };
        const projects = Array.isArray(meta.projects)
          ? meta.projects.filter((p): p is string => typeof p === "string")
          : typeof meta.project === "string"
            ? [meta.project]
            : [DEFAULT_PROJECT];
        return {
          id: r.document.id,
          content: r.document.content,
          similarity: r.score,
          project: projects[0] ?? DEFAULT_PROJECT,
          projects,
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

    // Match the requested project against either the canonical
    // metadata.projects[] array or — for chunks predating the migration —
    // the legacy metadata.project scalar. The migrate() routine converts
    // legacy chunks at startup, so the second clause is just a safety net.
    const projectClause = projectFilter !== null
      ? `AND (
            EXISTS (
              SELECT 1 FROM json_each(json_extract(pc.metadata, '$.projects'))
               WHERE value = ?
            )
            OR json_extract(pc.metadata, '$.project') = ?
          )`
      : "";

    const totalArgs: (string | number)[] = [COLLECTION, ...refs];
    if (projectFilter !== null) totalArgs.push(projectFilter, projectFilter);

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
    if (projectFilter !== null) listArgs.push(projectFilter, projectFilter);
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
        projects?: unknown;
      }>(r.metadata, {});
      const projects = Array.isArray(meta.projects)
        ? meta.projects.filter((p): p is string => typeof p === "string")
        : typeof meta.project === "string"
          ? [meta.project]
          : [DEFAULT_PROJECT];
      return {
        id: r.id,
        content: r.content,
        createdAt: meta.createdAt ?? null,
        source: meta.source ?? null,
        project: projects[0] ?? DEFAULT_PROJECT,
        projects,
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

// GET /api/plugins/supermemory/projects
// Returns the distinct project slugs the caller has any read access to —
// own memories plus team-shared memories. Used by the routing extractor so
// the LLM can pick an existing slug rather than inventing variants.
async function handleProjects(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    if (!hasCollection(COLLECTION)) {
      return Response.json({ projects: [] });
    }
    const refs = memoryReadRefs(auth.email);
    const refPh = placeholders(refs.length);
    // Enumerate slugs from the canonical metadata.projects[] array, plus a
    // safety-net union with the legacy scalar metadata.project (kept for
    // anything pre-migration).
    const rows = db
      .prepare(
        `SELECT DISTINCT slug FROM (
            SELECT je.value AS slug
              FROM plugin_chunks pc
              JOIN plugin_ref_chunks prc
                ON prc.collection = pc.collection AND prc.chunk_id = pc.chunk_id,
                   json_each(json_extract(pc.metadata, '$.projects')) je
             WHERE pc.collection = ?
               AND prc.ref_id IN (${refPh})
            UNION
            SELECT json_extract(pc.metadata, '$.project') AS slug
              FROM plugin_chunks pc
              JOIN plugin_ref_chunks prc
                ON prc.collection = pc.collection AND prc.chunk_id = pc.chunk_id
             WHERE pc.collection = ?
               AND prc.ref_id IN (${refPh})
               AND json_extract(pc.metadata, '$.project') IS NOT NULL
         )
         WHERE slug IS NOT NULL AND slug != ''`,
      )
      .all(COLLECTION, ...refs, COLLECTION, ...refs) as Array<{
        slug: string | null;
      }>;
    const projects = rows
      .map((r) => r.slug)
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .sort();
    return Response.json({ projects });
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
    "/projects": { GET: handleProjects },
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

    // Project shape cutover: legacy chunks store `metadata.project` (string).
    // The new model uses `metadata.projects` (string[]) so a chunk can live
    // in many buckets without duplicating the embedding. This is a one-shot
    // upgrade — once converted, the WHERE clause filters every row out and
    // the UPDATE is a no-op on subsequent boots.
    if (hasCollection(COLLECTION)) {
      const res = db
        .prepare(
          `UPDATE plugin_chunks
              SET metadata = json_set(
                json_remove(metadata, '$.project'),
                '$.projects',
                json_array(json_extract(metadata, '$.project'))
              )
            WHERE collection = ?
              AND json_extract(metadata, '$.project') IS NOT NULL
              AND json_extract(metadata, '$.projects') IS NULL`,
        )
        .run(COLLECTION);
      if (res.changes > 0) {
        console.log(
          `[supermemory] migrated ${res.changes} chunk(s) from metadata.project → metadata.projects[]`,
        );
      }
    }
  },
};
