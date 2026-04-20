/**
 * Vector DB API — tenant-scoped REST surface consumed by plugins
 * (e.g. claude-context) that need per-user vector storage backed by sqlite-vec.
 *
 * All routes require a valid API key; data is scoped by api_key_hash.
 */

import {
  requireUser,
  validateApiKey,
  isVecLoaded,
} from "../lib/db";
import { extractApiKey } from "../lib/auth";
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
  type VectorDocument,
} from "../lib/vectordb";

function errJson(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

async function resolveKeyHash(
  req: Request,
): Promise<string | Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const apiKey = extractApiKey(req);
  if (!apiKey) return errJson("API key required (Bearer token)", 401);
  const record = validateApiKey(apiKey);
  if (!record) return errJson("Invalid API key", 401);
  return record.keyHash;
}

function checkVecReady(): Response | null {
  if (!isVecLoaded()) {
    return errJson(
      "sqlite-vec extension is not loaded on this gateway",
      503,
    );
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

// ── Handlers ────────────────────────────────────────────────────────────────

async function createCollectionHandler(req: Request): Promise<Response> {
  const keyHash = await resolveKeyHash(req);
  if (keyHash instanceof Response) return keyHash;
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
    const res = createCollection(keyHash, body.name, body.dimension as number);
    return Response.json({ name: body.name, dimension: body.dimension, created: res.created }, { status: res.created ? 201 : 200 });
  } catch (err) {
    return errJson(err instanceof Error ? err.message : String(err));
  }
}

async function listCollectionsHandler(req: Request): Promise<Response> {
  const keyHash = await resolveKeyHash(req);
  if (keyHash instanceof Response) return keyHash;
  return Response.json({ names: listCollections(keyHash) });
}

async function handleCollectionByName(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const name = parseCollectionNameFromPath(url.pathname, "/api/vectordb/collections/");
  if (!name) return null;

  const keyHash = await resolveKeyHash(req);
  if (keyHash instanceof Response) return keyHash;

  if (req.method === "GET") {
    const info = getCollection(keyHash, name);
    if (!info) {
      return Response.json({ exists: false, name, rowCount: 0, dimension: 0 });
    }
    return Response.json({ exists: true, ...info });
  }

  if (req.method === "DELETE") {
    try {
      dropCollection(keyHash, name);
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

  const keyHash = await resolveKeyHash(req);
  if (keyHash instanceof Response) return keyHash;
  const vec = checkVecReady();
  if (vec) return vec;

  let body: { documents?: VectorDocument[] };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }
  if (!Array.isArray(body.documents)) return errJson("documents must be an array");
  if (!hasCollection(keyHash, name)) return errJson("Collection not found", 404);

  try {
    const res = insertDocuments(keyHash, name, body.documents);
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

  const keyHash = await resolveKeyHash(req);
  if (keyHash instanceof Response) return keyHash;
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
  if (!hasCollection(keyHash, name)) return errJson("Collection not found", 404);

  try {
    const results = searchVectors(
      keyHash,
      name,
      body.queryVector,
      body.topK ?? 10,
      body.filterExpr ?? null,
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

  const keyHash = await resolveKeyHash(req);
  if (keyHash instanceof Response) return keyHash;
  const vec = checkVecReady();
  if (vec) return vec;

  let body: { ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return errJson("Invalid JSON body");
  }
  if (!Array.isArray(body.ids)) return errJson("ids must be an array");

  try {
    const res = deleteByIds(keyHash, name, body.ids);
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

  const keyHash = await resolveKeyHash(req);
  if (keyHash instanceof Response) return keyHash;

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
  if (!hasCollection(keyHash, name)) return errJson("Collection not found", 404);

  try {
    const rows = queryByFilter(
      keyHash,
      name,
      body.filterExpr,
      body.outputFields ?? null,
      body.limit ?? 1000,
    );
    return Response.json({ rows });
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
  if (!url.pathname.startsWith("/api/vectordb/collections/")) return null;

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
  return handleCollectionByName(req);
}

export const vectorDbRoutes = {
  "/api/vectordb/collections": {
    GET: listCollectionsHandler,
    POST: createCollectionHandler,
  },
};
