/**
 * Tenant-scoped vector DB backed by sqlite-vec (vec0 virtual tables).
 *
 * One vec0 table per unique dimension (plugin_chunks_vec_<DIM>) — lazily
 * created on first createCollection. All rows carry api_key_hash + collection
 * so a single pair of physical tables serves every tenant.
 */

import { db, isVecLoaded } from "./db";

export interface VectorDocument {
  id: string;
  vector: number[];
  content: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  fileExtension: string;
  metadata: Record<string, unknown>;
}

export interface VectorSearchResult {
  document: VectorDocument;
  score: number;
}

const COLLECTION_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const vecTableCache = new Set<number>();

export function validateName(name: string): boolean {
  return COLLECTION_NAME_RE.test(name);
}

function vecTableName(dim: number): string {
  return `plugin_chunks_vec_${dim}`;
}

function ensureVecTable(dim: number): void {
  if (vecTableCache.has(dim)) return;
  if (!Number.isInteger(dim) || dim < 2 || dim > 4096) {
    throw new Error(`Invalid vector dimension: ${dim}`);
  }
  const name = vecTableName(dim);
  // vec0 partition-key syntax; if unsupported, fall back to an aux column.
  try {
    db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(
        rowid INTEGER PRIMARY KEY,
        api_key_hash TEXT PARTITION KEY,
        collection TEXT,
        vector FLOAT[${dim}]
      )`,
    );
  } catch {
    db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(
        rowid INTEGER PRIMARY KEY,
        +api_key_hash TEXT,
        +collection TEXT,
        vector FLOAT[${dim}]
      )`,
    );
  }
  vecTableCache.add(dim);
}

function requireVec() {
  if (!isVecLoaded()) {
    throw new Error("sqlite-vec extension is not loaded — vector features disabled");
  }
}

// ── Collection lifecycle ────────────────────────────────────────────────────

export function createCollection(
  apiKeyHash: string,
  name: string,
  dimension: number,
): { created: boolean } {
  requireVec();
  if (!validateName(name)) throw new Error("Invalid collection name");

  const existing = db
    .prepare(
      "SELECT dimension FROM plugin_collections WHERE api_key_hash = ? AND name = ?",
    )
    .get(apiKeyHash, name) as { dimension: number } | undefined;

  if (existing) {
    if (existing.dimension !== dimension) {
      throw new Error(
        `Collection '${name}' already exists with dimension ${existing.dimension}, not ${dimension}. Clear it first.`,
      );
    }
    return { created: false };
  }

  ensureVecTable(dimension);
  db.prepare(
    `INSERT INTO plugin_collections (api_key_hash, name, dimension, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(apiKeyHash, name, dimension, Date.now());
  return { created: true };
}

export function dropCollection(apiKeyHash: string, name: string): void {
  if (!validateName(name)) throw new Error("Invalid collection name");
  const row = db
    .prepare(
      "SELECT dimension FROM plugin_collections WHERE api_key_hash = ? AND name = ?",
    )
    .get(apiKeyHash, name) as { dimension: number } | undefined;
  if (!row) return;

  const tx = db.transaction(() => {
    const rowIds = db
      .prepare(
        "SELECT rowid FROM plugin_chunks WHERE api_key_hash = ? AND collection = ?",
      )
      .all(apiKeyHash, name) as { rowid: number }[];

    if (rowIds.length > 0 && isVecLoaded()) {
      const vecTable = vecTableName(row.dimension);
      const delVec = db.prepare(`DELETE FROM ${vecTable} WHERE rowid = ?`);
      for (const { rowid } of rowIds) delVec.run(rowid);
    }

    db.prepare(
      "DELETE FROM plugin_chunks WHERE api_key_hash = ? AND collection = ?",
    ).run(apiKeyHash, name);

    db.prepare(
      "DELETE FROM plugin_collections WHERE api_key_hash = ? AND name = ?",
    ).run(apiKeyHash, name);
  });
  tx();
}

export function hasCollection(apiKeyHash: string, name: string): boolean {
  if (!validateName(name)) return false;
  const row = db
    .prepare(
      "SELECT 1 FROM plugin_collections WHERE api_key_hash = ? AND name = ?",
    )
    .get(apiKeyHash, name);
  return !!row;
}

export function getCollection(
  apiKeyHash: string,
  name: string,
): { name: string; dimension: number; rowCount: number } | null {
  if (!validateName(name)) return null;
  const row = db
    .prepare(
      "SELECT dimension FROM plugin_collections WHERE api_key_hash = ? AND name = ?",
    )
    .get(apiKeyHash, name) as { dimension: number } | undefined;
  if (!row) return null;
  const count = db
    .prepare(
      "SELECT COUNT(*) AS n FROM plugin_chunks WHERE api_key_hash = ? AND collection = ?",
    )
    .get(apiKeyHash, name) as { n: number };
  return { name, dimension: row.dimension, rowCount: count.n };
}

export function listCollections(apiKeyHash: string): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM plugin_collections WHERE api_key_hash = ? ORDER BY name",
    )
    .all(apiKeyHash) as { name: string }[];
  return rows.map((r) => r.name);
}

// ── Document CRUD ───────────────────────────────────────────────────────────

export function insertDocuments(
  apiKeyHash: string,
  collection: string,
  documents: VectorDocument[],
): { inserted: number } {
  requireVec();
  if (!validateName(collection)) throw new Error("Invalid collection name");
  if (!documents.length) return { inserted: 0 };

  const coll = db
    .prepare(
      "SELECT dimension FROM plugin_collections WHERE api_key_hash = ? AND name = ?",
    )
    .get(apiKeyHash, collection) as { dimension: number } | undefined;
  if (!coll) throw new Error(`Collection '${collection}' does not exist`);

  for (const doc of documents) {
    if (doc.vector.length !== coll.dimension) {
      throw new Error(
        `Vector length ${doc.vector.length} does not match collection dimension ${coll.dimension}`,
      );
    }
  }

  ensureVecTable(coll.dimension);
  const vecTable = vecTableName(coll.dimension);

  const upsertChunk = db.prepare(
    `INSERT INTO plugin_chunks
       (api_key_hash, collection, chunk_id, content, relative_path,
        start_line, end_line, file_extension, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(api_key_hash, collection, chunk_id) DO UPDATE SET
       content = excluded.content,
       relative_path = excluded.relative_path,
       start_line = excluded.start_line,
       end_line = excluded.end_line,
       file_extension = excluded.file_extension,
       metadata = excluded.metadata
     RETURNING rowid`,
  );
  const delVec = db.prepare(`DELETE FROM ${vecTable} WHERE rowid = ?`);
  const insertVec = db.prepare(
    `INSERT INTO ${vecTable} (rowid, api_key_hash, collection, vector)
     VALUES (?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const doc of documents) {
      const row = upsertChunk.get(
        apiKeyHash,
        collection,
        doc.id,
        doc.content,
        doc.relativePath,
        doc.startLine,
        doc.endLine,
        doc.fileExtension,
        JSON.stringify(doc.metadata ?? {}),
      ) as { rowid: number };
      delVec.run(row.rowid);
      insertVec.run(row.rowid, apiKeyHash, collection, JSON.stringify(doc.vector));
      inserted++;
    }
  });
  tx();
  return { inserted };
}

// ── Filter expression parser (minimal: `<field> in ["a", "b"]`) ─────────────

const ALLOWED_FILTER_FIELDS = new Set([
  "relativePath",
  "relative_path",
  "fileExtension",
  "file_extension",
  "id",
  "chunk_id",
]);

const FIELD_TO_COLUMN: Record<string, string> = {
  relativePath: "relative_path",
  relative_path: "relative_path",
  fileExtension: "file_extension",
  file_extension: "file_extension",
  id: "chunk_id",
  chunk_id: "chunk_id",
};

export interface ParsedFilter {
  column: string;
  values: string[];
}

export function parseFilterExpr(expr: string): ParsedFilter | null {
  if (!expr || !expr.trim()) return null;
  const match = expr.match(/^\s*(\w+)\s+in\s+\[(.*)\]\s*$/i);
  if (!match) {
    throw new Error(
      `Unsupported filter expression. Only '<field> in [...]' is supported: ${expr}`,
    );
  }
  const field = match[1];
  if (!ALLOWED_FILTER_FIELDS.has(field)) {
    throw new Error(`Unsupported filter field: ${field}`);
  }
  const body = match[2];
  if (!body.trim()) return { column: FIELD_TO_COLUMN[field], values: [] };

  const values: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    values.push((m[1] ?? m[2]).replace(/\\(.)/g, "$1"));
  }
  return { column: FIELD_TO_COLUMN[field], values };
}

// ── Search ──────────────────────────────────────────────────────────────────

export function searchVectors(
  apiKeyHash: string,
  collection: string,
  queryVector: number[],
  topK: number,
  filterExpr: string | null,
): VectorSearchResult[] {
  requireVec();
  if (!validateName(collection)) throw new Error("Invalid collection name");
  const coll = db
    .prepare(
      "SELECT dimension FROM plugin_collections WHERE api_key_hash = ? AND name = ?",
    )
    .get(apiKeyHash, collection) as { dimension: number } | undefined;
  if (!coll) throw new Error(`Collection '${collection}' does not exist`);
  if (queryVector.length !== coll.dimension) {
    throw new Error(
      `Query vector length ${queryVector.length} does not match collection dimension ${coll.dimension}`,
    );
  }

  const vecTable = vecTableName(coll.dimension);
  const parsed = filterExpr ? parseFilterExpr(filterExpr) : null;
  const k = Math.max(1, Math.min(200, Math.floor(topK) || 10));

  // Overfetch when filter applied; apply filter after KNN.
  const knnLimit = parsed ? k * 4 : k;
  const nearest = db
    .prepare(
      `SELECT rowid, distance
         FROM ${vecTable}
        WHERE vector MATCH ?
          AND k = ?
          AND api_key_hash = ?
          AND collection = ?`,
    )
    .all(JSON.stringify(queryVector), knnLimit, apiKeyHash, collection) as {
    rowid: number;
    distance: number;
  }[];

  if (nearest.length === 0) return [];

  const rowIds = nearest.map((n) => n.rowid);
  const placeholders = rowIds.map(() => "?").join(",");
  let sql = `SELECT * FROM plugin_chunks WHERE rowid IN (${placeholders})`;
  const args: (string | number)[] = [...rowIds];
  if (parsed && parsed.values.length > 0) {
    sql += ` AND ${parsed.column} IN (${parsed.values.map(() => "?").join(",")})`;
    args.push(...parsed.values);
  } else if (parsed && parsed.values.length === 0) {
    return [];
  }
  const chunkRows = db.prepare(sql).all(...args) as Record<string, unknown>[];
  const chunkByRowId = new Map<number, Record<string, unknown>>();
  for (const r of chunkRows) chunkByRowId.set(r.rowid as number, r);

  const results: VectorSearchResult[] = [];
  for (const n of nearest) {
    const chunk = chunkByRowId.get(n.rowid);
    if (!chunk) continue;
    results.push({
      document: rowToDocument(chunk),
      score: 1 - n.distance, // convert cosine distance to similarity
    });
    if (results.length >= k) break;
  }
  return results;
}

function rowToDocument(row: Record<string, unknown>): VectorDocument {
  return {
    id: row.chunk_id as string,
    vector: [], // not returned in search
    content: row.content as string,
    relativePath: row.relative_path as string,
    startLine: row.start_line as number,
    endLine: row.end_line as number,
    fileExtension: (row.file_extension as string) ?? "",
    metadata: row.metadata
      ? safeJsonParse(row.metadata as string)
      : {},
  };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────

export function deleteByIds(
  apiKeyHash: string,
  collection: string,
  ids: string[],
): { deleted: number } {
  requireVec();
  if (!validateName(collection)) throw new Error("Invalid collection name");
  if (!ids.length) return { deleted: 0 };

  const coll = db
    .prepare(
      "SELECT dimension FROM plugin_collections WHERE api_key_hash = ? AND name = ?",
    )
    .get(apiKeyHash, collection) as { dimension: number } | undefined;
  if (!coll) return { deleted: 0 };

  const vecTable = vecTableName(coll.dimension);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT rowid FROM plugin_chunks
        WHERE api_key_hash = ? AND collection = ? AND chunk_id IN (${placeholders})`,
    )
    .all(apiKeyHash, collection, ...ids) as { rowid: number }[];

  if (!rows.length) return { deleted: 0 };
  const rowIds = rows.map((r) => r.rowid);
  const rowPlaceholders = rowIds.map(() => "?").join(",");

  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM ${vecTable} WHERE rowid IN (${rowPlaceholders})`,
    ).run(...rowIds);
    db.prepare(
      `DELETE FROM plugin_chunks WHERE rowid IN (${rowPlaceholders})`,
    ).run(...rowIds);
  });
  tx();
  return { deleted: rows.length };
}

// ── Query by filter (no vector search) ──────────────────────────────────────

export function queryByFilter(
  apiKeyHash: string,
  collection: string,
  filterExpr: string,
  outputFields: string[] | null,
  limit: number,
): Record<string, unknown>[] {
  if (!validateName(collection)) throw new Error("Invalid collection name");
  const parsed = parseFilterExpr(filterExpr);
  if (!parsed) return [];
  const cap = Math.max(1, Math.min(10_000, Math.floor(limit) || 1000));

  if (parsed.values.length === 0) return [];

  const placeholders = parsed.values.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM plugin_chunks
        WHERE api_key_hash = ? AND collection = ?
          AND ${parsed.column} IN (${placeholders})
        LIMIT ?`,
    )
    .all(apiKeyHash, collection, ...parsed.values, cap) as Record<string, unknown>[];

  return rows.map((r) => projectRow(r, outputFields));
}

function projectRow(
  row: Record<string, unknown>,
  outputFields: string[] | null,
): Record<string, unknown> {
  const full: Record<string, unknown> = {
    id: row.chunk_id,
    content: row.content,
    relativePath: row.relative_path,
    startLine: row.start_line,
    endLine: row.end_line,
    fileExtension: row.file_extension,
    metadata: row.metadata ? safeJsonParse(row.metadata as string) : {},
  };
  if (!outputFields || !outputFields.length) return full;
  const projected: Record<string, unknown> = {};
  for (const f of outputFields) if (f in full) projected[f] = full[f];
  return projected;
}
