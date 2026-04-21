/**
 * Vector DB API — REST surface consumed by plugins (e.g. claude-context).
 *
 * Collections are globally shared across all authenticated clients. Branch /
 * user isolation is expressed via ref overlays (`plugin_ref_chunks`): the
 * indexer declares which chunks a ref considers live, and search filters
 * KNN results to that set via `?ref=<id>`.
 *
 * All routes require a valid API key for auth, but the caller's key is no
 * longer used to partition data.
 */

import {
  db,
  requireUser,
  requireAdmin,
  listUserTeams,
  teamRefId,
  userMemoryRefId,
  isVecLoaded,
} from "../lib/db";
import {
  createCollection,
  dropCollection,
  getCollection,
  hasCollection,
  listCollections,
  insertDocuments,
  searchVectors,
  deleteByIds,
  queryByFilter,
  validateName,
  validateRefId,
  listExistingChunkIds,
  setRefOverlay,
  appendRefOverlay,
  getRefOverlay,
  gcOrphanedChunks,
  type VectorDocument,
  type RefOverlayEntry,
} from "../lib/vectordb";

/**
 * Collection name that the supermemory plugin writes into. Chunks in this
 * collection are automatically scoped by the authenticated user's email (and,
 * on read, unioned with every team the user belongs to) via ref overlays —
 * teams are how admins let users share a memory pool.
 */
const MEMORIES_COLLECTION = "memories";

/** Pseudo-file path used for memory-scoped ref overlay rows. */
const MEMORY_REF_FILE = "memory";

function memoryReadRefs(email: string): string[] {
  const refs = [userMemoryRefId(email)];
  for (const t of listUserTeams(email)) refs.push(teamRefId(t.id));
  return refs;
}

function errJson(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function checkVecReady(): Response | null {
  if (!isVecLoaded()) {
    return errJson("sqlite-vec extension is not loaded on this gateway", 503);
  }
  return null;
}

function parseCollectionNameFromPath(
  pathname: string,
  prefix: string,
  suffix = "",
): string | null {
  if (!pathname.startsWith(prefix)) return null;
  let tail = pathname.slice(prefix.length);
  if (suffix) {
    if (!tail.endsWith(suffix)) return null;
    tail = tail.slice(0, -suffix.length);
  }
  if (!tail || tail.includes("/")) return null;
  return validateName(tail) ? tail : null;
}

/** Parse `/api/vectordb/collections/<name>/refs/<ref>[/<suffix>]` URLs. */
function parseCollectionAndRef(
  pathname: string,
  suffix = "",
): { name: string; refId: string } | null {
  const prefix = "/api/vectordb/collections/";
  if (!pathname.startsWith(prefix)) return null;
  let tail = pathname.slice(prefix.length);
  const refsIdx = tail.indexOf("/refs/");
  if (refsIdx < 0) return null;
  const name = tail.slice(0, refsIdx);
  if (!validateName(name)) return null;
  let refPart = tail.slice(refsIdx + "/refs/".length);
  if (suffix) {
    if (!refPart.endsWith(suffix)) return null;
    refPart = refPart.slice(0, -suffix.length);
  }
  if (!refPart) return null;
  const refId = decodeURIComponent(refPart);
  if (!validateRefId(refId)) return null;
  return { name, refId };
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function createCollectionHandler(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const vec = checkVecReady();
  if (vec) return vec;

  let body: { name?: string; dimension?: number };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }
  if (!body.name || !validateName(body.name)) return errJson("Invalid name");
  if (!Number.isInteger(body.dimension) || (body.dimension as number) < 2) {
    return errJson("Invalid dimension");
  }
  try {
    const res = createCollection(body.name, body.dimension as number);
    return Response.json(
      { name: body.name, dimension: body.dimension, created: res.created },
      { status: res.created ? 201 : 200 },
    );
  } catch (err) {
    return errJson(err instanceof Error ? err.message : String(err));
  }
}

async function listCollectionsHandler(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  return Response.json({ names: listCollections() });
}

async function handleCollectionByName(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const name = parseCollectionNameFromPath(url.pathname, "/api/vectordb/collections/");
  if (!name) return null;

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  if (req.method === "GET") {
    const info = getCollection(name);
    if (!info) {
      return Response.json({ exists: false, name, rowCount: 0, dimension: 0 });
    }
    return Response.json({ exists: true, ...info });
  }

  if (req.method === "DELETE") {
    try {
      dropCollection(name);
      return new Response(null, { status: 204 });
    } catch (err) {
      return errJson(err instanceof Error ? err.message : String(err));
    }
  }

  return errJson("Method not allowed", 405);
}

async function handleInsert(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const name = parseCollectionNameFromPath(
    url.pathname,
    "/api/vectordb/collections/",
    "/insert",
  );
  if (!name) return null;

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const vec = checkVecReady();
  if (vec) return vec;

  let body: { documents?: VectorDocument[] };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }
  if (!Array.isArray(body.documents)) return errJson("documents must be an array");
  if (!hasCollection(name)) return errJson("Collection not found", 404);

  try {
    const res = insertDocuments(name, body.documents);
    // For the memories collection, auto-tag freshly inserted chunks with the
    // caller's user ref. Reads union this ref with the caller's teams so each
    // user sees their own memories plus any team memories they're in on.
    if (name === MEMORIES_COLLECTION) {
      const chunkIds = body.documents
        .map((d) => d?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (chunkIds.length > 0) {
        appendRefOverlay(name, userMemoryRefId(auth.email), MEMORY_REF_FILE, chunkIds);
      }
    }
    return Response.json(res);
  } catch (err) {
    return errJson(err instanceof Error ? err.message : String(err));
  }
}

async function handleSearch(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const name = parseCollectionNameFromPath(
    url.pathname,
    "/api/vectordb/collections/",
    "/search",
  );
  if (!name) return null;

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const vec = checkVecReady();
  if (vec) return vec;

  let body: {
    queryVector?: number[];
    topK?: number;
    filterExpr?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }
  if (!Array.isArray(body.queryVector)) return errJson("queryVector required");
  if (!hasCollection(name)) return errJson("Collection not found", 404);

  const refId = url.searchParams.get("ref");
  if (refId !== null && !validateRefId(refId)) return errJson("Invalid ref id");

  // For the memories collection: if the caller didn't pass an explicit ?ref=,
  // auto-scope to the caller's own memories plus every team they belong to.
  // Callers who *do* pass ?ref= (e.g. admin tools, tests) keep full control.
  const refArg: string | string[] | null =
    name === MEMORIES_COLLECTION && refId === null
      ? memoryReadRefs(auth.email)
      : refId;

  try {
    const results = searchVectors(
      name,
      body.queryVector,
      body.topK ?? 10,
      body.filterExpr ?? null,
      refArg,
    );
    return Response.json({ results });
  } catch (err) {
    return errJson(err instanceof Error ? err.message : String(err));
  }
}

async function handleDelete(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const name = parseCollectionNameFromPath(
    url.pathname,
    "/api/vectordb/collections/",
    "/delete",
  );
  if (!name) return null;

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const vec = checkVecReady();
  if (vec) return vec;

  let body: { ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }
  if (!Array.isArray(body.ids)) return errJson("ids must be an array");

  // For the memories collection, restrict deletes to chunks the caller owns
  // (i.e. that are in their user:<email> ref overlay). Team memories can only
  // be deleted by admins via the team-scoped admin API — not here.
  let ids = body.ids.filter((x): x is string => typeof x === "string" && x.length > 0);
  if (name === MEMORIES_COLLECTION && ids.length > 0) {
    ids = listExistingChunkIds(name, ids);
    if (ids.length > 0) {
      const ownRef = userMemoryRefId(auth.email);
      const phs = ids.map(() => "?").join(",");
      const owned = db
        .prepare(
          `SELECT DISTINCT chunk_id FROM plugin_ref_chunks
            WHERE collection = ? AND ref_id = ? AND chunk_id IN (${phs})`,
        )
        .all(MEMORIES_COLLECTION, ownRef, ...ids) as { chunk_id: string }[];
      ids = owned.map((r) => r.chunk_id);
    }
    if (ids.length === 0) return Response.json({ deleted: 0 });
  }

  try {
    const res = deleteByIds(name, ids);
    return Response.json(res);
  } catch (err) {
    return errJson(err instanceof Error ? err.message : String(err));
  }
}

async function handleQuery(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const name = parseCollectionNameFromPath(
    url.pathname,
    "/api/vectordb/collections/",
    "/query",
  );
  if (!name) return null;

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: {
    filterExpr?: string;
    outputFields?: string[];
    limit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }
  if (!body.filterExpr) return errJson("filterExpr required");
  if (!hasCollection(name)) return errJson("Collection not found", 404);

  // Same memory-collection scoping as /search — keep the two endpoints aligned.
  const refs: string[] | null =
    name === MEMORIES_COLLECTION ? memoryReadRefs(auth.email) : null;

  try {
    const rows = queryByFilter(
      name,
      body.filterExpr,
      body.outputFields ?? null,
      body.limit ?? 1000,
      refs,
    );
    return Response.json({ rows });
  } catch (err) {
    return errJson(err instanceof Error ? err.message : String(err));
  }
}

async function handleExistingChunks(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const name = parseCollectionNameFromPath(
    url.pathname,
    "/api/vectordb/collections/",
    "/chunks/existing",
  );
  if (!name) return null;

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: { chunkIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }
  if (!Array.isArray(body.chunkIds)) return errJson("chunkIds must be an array");
  const ids = (body.chunkIds as unknown[]).filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  if (!hasCollection(name)) return errJson("Collection not found", 404);

  try {
    return Response.json({ existing: listExistingChunkIds(name, ids) });
  } catch (err) {
    return errJson(err instanceof Error ? err.message : String(err));
  }
}

async function handleOverlayPost(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const parsed = parseCollectionAndRef(url.pathname, "/overlay");
  if (!parsed) return null;

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: { entries?: unknown };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }
  if (!Array.isArray(body.entries)) return errJson("entries must be an array");
  if (!hasCollection(parsed.name)) return errJson("Collection not found", 404);

  const entries: RefOverlayEntry[] = (body.entries as unknown[])
    .filter((e): e is { filePath: unknown; chunkIds: unknown } => typeof e === "object" && e !== null)
    .map((e) => ({
      filePath: typeof e.filePath === "string" ? e.filePath : "",
      chunkIds: Array.isArray(e.chunkIds)
        ? (e.chunkIds as unknown[]).filter(
            (x): x is string => typeof x === "string" && x.length > 0,
          )
        : [],
    }))
    .filter((e) => e.filePath.length > 0);

  try {
    const res = setRefOverlay(parsed.name, parsed.refId, entries);
    return Response.json(res);
  } catch (err) {
    return errJson(err instanceof Error ? err.message : String(err));
  }
}

async function handleOverlayGet(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const parsed = parseCollectionAndRef(url.pathname);
  if (!parsed) return null;

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  if (!hasCollection(parsed.name)) return errJson("Collection not found", 404);

  try {
    return Response.json({ entries: getRefOverlay(parsed.name, parsed.refId) });
  } catch (err) {
    return errJson(err instanceof Error ? err.message : String(err));
  }
}

async function handleAdminGc(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const vec = checkVecReady();
  if (vec) return vec;
  try {
    const res = gcOrphanedChunks();
    return Response.json(res);
  } catch (err) {
    return errJson(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fallback dispatcher for parameterized vectordb paths.
 * Returns null if the URL doesn't match any vectordb route.
 */
export async function handleVectorDbByName(
  req: Request,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/vectordb/")) return null;

  if (url.pathname === "/api/vectordb/gc" && req.method === "POST") {
    return handleAdminGc(req);
  }
  if (!url.pathname.startsWith("/api/vectordb/collections/")) return null;

  // Order matters: longer suffixes first so /chunks/existing isn't swallowed
  // by a name parser that treats "chunks" as a collection path segment.
  if (url.pathname.endsWith("/chunks/existing") && req.method === "POST") {
    return handleExistingChunks(req);
  }
  if (url.pathname.endsWith("/insert") && req.method === "POST") {
    return handleInsert(req);
  }
  if (url.pathname.endsWith("/search") && req.method === "POST") {
    return handleSearch(req);
  }
  if (url.pathname.endsWith("/delete") && req.method === "POST") {
    return handleDelete(req);
  }
  if (url.pathname.endsWith("/query") && req.method === "POST") {
    return handleQuery(req);
  }
  if (url.pathname.endsWith("/overlay") && req.method === "POST") {
    return handleOverlayPost(req);
  }
  if (url.pathname.includes("/refs/") && req.method === "GET") {
    return handleOverlayGet(req);
  }
  return handleCollectionByName(req);
}

export const vectorDbRoutes = {
  "/api/vectordb/collections": {
    GET: listCollectionsHandler,
    POST: createCollectionHandler,
  },
};
