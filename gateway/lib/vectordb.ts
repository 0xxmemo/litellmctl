/**
 * Shared vector DB backed by sqlite-vec (vec0 virtual tables).
 *
 * All collections are globally shared across authenticated clients; per-
 * branch / per-user isolation is expressed via ref overlays (plugin_ref_chunks)
 * rather than by tenant-scoped rows. One vec0 table per unique dimension
 * (plugin_chunks_vec_<DIM>) is lazily created on first createCollection.
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

export interface RefOverlayEntry {
  filePath: string;
  chunkIds: string[];
  fileHash?: string;
}

const COLLECTION_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const REF_ID_RE = /^[a-zA-Z0-9_:.\/-]{1,128}$/;
const vecTableCache = new Set<number>();

export function validateName(name: string): boolean {
  return COLLECTION_NAME_RE.test(name);
}

export function validateRefId(refId: string): boolean {
  return REF_ID_RE.test(refId);
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
  db.run(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(
      rowid INTEGER PRIMARY KEY,
      +collection TEXT,
      vector FLOAT[${dim}]
    )`,
  );
  vecTableCache.add(dim);
}

function requireVec() {
  if (!isVecLoaded()) {
    throw new Error("sqlite-vec extension is not loaded — vector features disabled");
  }
}

// ── Collection lifecycle ────────────────────────────────────────────────────

export function createCollection(
  name: string,
  dimension: number,
): { created: boolean } {
  requireVec();
  if (!validateName(name)) throw new Error("Invalid collection name");

  const existing = db
    .prepare("SELECT dimension FROM plugin_collections WHERE name = ?")
    .get(name) as { dimension: number } | undefined;

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
    `INSERT INTO plugin_collections (name, dimension, created_at) VALUES (?, ?, ?)`,
  ).run(name, dimension, Date.now());
  return { created: true };
}

export function dropCollection(name: string): void {
  if (!validateName(name)) throw new Error("Invalid collection name");
  const row = db
    .prepare("SELECT dimension FROM plugin_collections WHERE name = ?")
    .get(name) as { dimension: number } | undefined;
  if (!row) return;

  const tx = db.transaction(() => {
    const rowIds = db
      .prepare("SELECT rowid FROM plugin_chunks WHERE collection = ?")
      .all(name) as { rowid: number }[];

    if (rowIds.length > 0 && isVecLoaded()) {
      const vecTable = vecTableName(row.dimension);
      const delVec = db.prepare(`DELETE FROM ${vecTable} WHERE rowid = ?`);
      for (const { rowid } of rowIds) delVec.run(rowid);
    }

    db.prepare("DELETE FROM plugin_ref_chunks WHERE collection = ?").run(name);
    db.prepare("DELETE FROM plugin_chunks WHERE collection = ?").run(name);
    db.prepare("DELETE FROM plugin_collections WHERE name = ?").run(name);
  });
  tx();
}

export function hasCollection(name: string): boolean {
  if (!validateName(name)) return false;
  const row = db
    .prepare("SELECT 1 FROM plugin_collections WHERE name = ?")
    .get(name);
  return !!row;
}

export function getCollection(
  name: string,
): { name: string; dimension: number; rowCount: number } | null {
  if (!validateName(name)) return null;
  const row = db
    .prepare("SELECT dimension FROM plugin_collections WHERE name = ?")
    .get(name) as { dimension: number } | undefined;
  if (!row) return null;
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM plugin_chunks WHERE collection = ?")
    .get(name) as { n: number };
  return { name, dimension: row.dimension, rowCount: count.n };
}

export function listCollections(): string[] {
  const rows = db
    .prepare("SELECT name FROM plugin_collections ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

// ── Document CRUD ───────────────────────────────────────────────────────────

export function insertDocuments(
  collection: string,
  documents: VectorDocument[],
): { inserted: number } {
  requireVec();
  if (!validateName(collection)) throw new Error("Invalid collection name");
  if (!documents.length) return { inserted: 0 };

  const coll = db
    .prepare("SELECT dimension FROM plugin_collections WHERE name = ?")
    .get(collection) as { dimension: number } | undefined;
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
       (collection, chunk_id, content, relative_path,
        start_line, end_line, file_extension, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(collection, chunk_id) DO UPDATE SET
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
    `INSERT INTO ${vecTable} (rowid, collection, vector) VALUES (?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const doc of documents) {
      const row = upsertChunk.get(
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
      insertVec.run(row.rowid, collection, JSON.stringify(doc.vector));
      inserted++;
    }
  });
  tx();
  return { inserted };
}

/** Return the subset of chunkIds that are already stored in this collection. */
export function listExistingChunkIds(
  collection: string,
  chunkIds: string[],
): string[] {
  if (!validateName(collection)) throw new Error("Invalid collection name");
  if (!chunkIds.length) return [];
  // SQLite host-parameter limit is 999 by default — batch defensively.
  const CAP = 800;
  const existing: string[] = [];
  for (let i = 0; i < chunkIds.length; i += CAP) {
    const slice = chunkIds.slice(i, i + CAP);
    const placeholders = slice.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT chunk_id FROM plugin_chunks
          WHERE collection = ? AND chunk_id IN (${placeholders})`,
      )
      .all(collection, ...slice) as { chunk_id: string }[];
    for (const r of rows) existing.push(r.chunk_id);
  }
  return existing;
}

// ── Ref overlay ─────────────────────────────────────────────────────────────

/**
 * Atomically replace the overlay for (collection, refId). Any existing rows
 * for this ref that aren't in `entries` are deleted — callers always send
 * the full set of live (file, chunks) pairs for the ref.
 */
export function setRefOverlay(
  collection: string,
  refId: string,
  entries: RefOverlayEntry[],
): { inserted: number } {
  if (!validateName(collection)) throw new Error("Invalid collection name");
  if (!validateRefId(refId)) throw new Error("Invalid ref id");
  if (!hasCollection(collection)) throw new Error(`Collection '${collection}' does not exist`);

  const now = Date.now();
  const del = db.prepare(
    "DELETE FROM plugin_ref_chunks WHERE collection = ? AND ref_id = ?",
  );
  const ins = db.prepare(
    `INSERT OR IGNORE INTO plugin_ref_chunks
       (collection, ref_id, file_path, chunk_id, updated_at, file_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    del.run(collection, refId);
    for (const entry of entries) {
      if (typeof entry.filePath !== "string" || !entry.filePath) continue;
      if (!Array.isArray(entry.chunkIds)) continue;
      const fileHash = typeof entry.fileHash === "string" ? entry.fileHash : null;
      for (const chunkId of entry.chunkIds) {
        if (typeof chunkId !== "string" || !chunkId) continue;
        const res = ins.run(collection, refId, entry.filePath, chunkId, now, fileHash);
        if ((res as { changes?: number }).changes) inserted++;
      }
    }
  });
  tx();
  return { inserted };
}

/**
 * Append-only variant of setRefOverlay. Used by incremental writers (e.g.
 * the memories collection, which adds one chunk at a time and must not wipe
 * prior overlay rows the way setRefOverlay does). For each chunkId, insert a
 * single (collection, refId, filePath, chunkId) row; existing rows are left
 * alone via INSERT OR IGNORE.
 */
export function appendRefOverlay(
  collection: string,
  refId: string,
  filePath: string,
  chunkIds: string[],
): { inserted: number } {
  if (!validateName(collection)) throw new Error("Invalid collection name");
  if (!validateRefId(refId)) throw new Error("Invalid ref id");
  if (!chunkIds.length) return { inserted: 0 };
  if (typeof filePath !== "string" || !filePath) {
    throw new Error("filePath required for appendRefOverlay");
  }

  const ins = db.prepare(
    `INSERT OR IGNORE INTO plugin_ref_chunks
       (collection, ref_id, file_path, chunk_id, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const chunkId of chunkIds) {
      if (typeof chunkId !== "string" || !chunkId) continue;
      const res = ins.run(collection, refId, filePath, chunkId, now);
      if ((res as { changes?: number }).changes) inserted++;
    }
  });
  tx();
  return { inserted };
}

export function getRefOverlay(
  collection: string,
  refId: string,
): RefOverlayEntry[] {
  if (!validateName(collection)) throw new Error("Invalid collection name");
  if (!validateRefId(refId)) throw new Error("Invalid ref id");
  const rows = db
    .prepare(
      `SELECT file_path, chunk_id, file_hash
         FROM plugin_ref_chunks
        WHERE collection = ? AND ref_id = ?
        ORDER BY file_path, chunk_id`,
    )
    .all(collection, refId) as {
      file_path: string;
      chunk_id: string;
      file_hash: string | null;
    }[];

  const byFile = new Map<string, { chunkIds: string[]; fileHash: string | null }>();
  for (const r of rows) {
    let entry = byFile.get(r.file_path);
    if (!entry) {
      entry = { chunkIds: [], fileHash: r.file_hash };
      byFile.set(r.file_path, entry);
    }
    entry.chunkIds.push(r.chunk_id);
    // All rows for the same (collection, ref_id, file_path) carry the same hash,
    // but fall back to the first non-null one if older rows from a legacy writer
    // left it as NULL.
    if (!entry.fileHash && r.file_hash) entry.fileHash = r.file_hash;
  }
  return Array.from(byFile.entries()).map(([filePath, v]) => ({
    filePath,
    chunkIds: v.chunkIds,
    ...(v.fileHash ? { fileHash: v.fileHash } : {}),
  }));
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
  collection: string,
  queryVector: number[],
  topK: number,
  filterExpr: string | null,
  refId: string | string[] | null = null,
): VectorSearchResult[] {
  requireVec();
  if (!validateName(collection)) throw new Error("Invalid collection name");
  const refIds: string[] | null = refId === null
    ? null
    : Array.isArray(refId)
      ? refId
      : [refId];
  if (refIds !== null) {
    for (const r of refIds) {
      if (!validateRefId(r)) throw new Error(`Invalid ref id: ${r}`);
    }
    if (refIds.length === 0) return [];
  }
  const coll = db
    .prepare("SELECT dimension FROM plugin_collections WHERE name = ?")
    .get(collection) as { dimension: number } | undefined;
  if (!coll) throw new Error(`Collection '${collection}' does not exist`);
  if (queryVector.length !== coll.dimension) {
    throw new Error(
      `Query vector length ${queryVector.length} does not match collection dimension ${coll.dimension}`,
    );
  }

  const vecTable = vecTableName(coll.dimension);
  const parsed = filterExpr ? parseFilterExpr(filterExpr) : null;
  const k = Math.max(1, Math.min(200, Math.floor(topK) || 10));

  // Overfetch when post-KNN filtering is active (filter expr or ref overlay).
  const postFilter = parsed !== null || refIds !== null;
  const knnLimit = postFilter ? k * 4 : k;
  const nearest = db
    .prepare(
      `SELECT rowid, distance
         FROM ${vecTable}
        WHERE vector MATCH ?
          AND k = ?
          AND collection = ?`,
    )
    .all(JSON.stringify(queryVector), knnLimit, collection) as {
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

  // Ref-overlay filter: only keep chunk_ids owned by any of the given refs.
  let allowedChunkIds: Set<string> | null = null;
  if (refIds !== null) {
    const chunkIds = chunkRows.map((r) => r.chunk_id as string).filter(Boolean);
    if (chunkIds.length === 0) return [];
    const CAP = 800;
    const refPhs = refIds.map(() => "?").join(",");
    allowedChunkIds = new Set();
    for (let i = 0; i < chunkIds.length; i += CAP) {
      const slice = chunkIds.slice(i, i + CAP);
      const phs = slice.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT DISTINCT chunk_id FROM plugin_ref_chunks
            WHERE collection = ? AND ref_id IN (${refPhs}) AND chunk_id IN (${phs})`,
        )
        .all(collection, ...refIds, ...slice) as { chunk_id: string }[];
      for (const r of rows) allowedChunkIds.add(r.chunk_id);
    }
  }

  const results: VectorSearchResult[] = [];
  for (const n of nearest) {
    const chunk = chunkByRowId.get(n.rowid);
    if (!chunk) continue;
    if (allowedChunkIds && !allowedChunkIds.has(chunk.chunk_id as string)) continue;
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
  collection: string,
  ids: string[],
): { deleted: number } {
  requireVec();
  if (!validateName(collection)) throw new Error("Invalid collection name");
  if (!ids.length) return { deleted: 0 };

  const coll = db
    .prepare("SELECT dimension FROM plugin_collections WHERE name = ?")
    .get(collection) as { dimension: number } | undefined;
  if (!coll) return { deleted: 0 };

  const vecTable = vecTableName(coll.dimension);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT rowid FROM plugin_chunks
        WHERE collection = ? AND chunk_id IN (${placeholders})`,
    )
    .all(collection, ...ids) as { rowid: number }[];

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
    // Best effort: also strip these chunk_ids from any ref overlays.
    const idPhs = ids.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM plugin_ref_chunks
        WHERE collection = ? AND chunk_id IN (${idPhs})`,
    ).run(collection, ...ids);
  });
  tx();
  return { deleted: rows.length };
}

// ── Query by filter (no vector search) ──────────────────────────────────────

export function queryByFilter(
  collection: string,
  filterExpr: string,
  outputFields: string[] | null,
  limit: number,
  refIds: string[] | null = null,
): Record<string, unknown>[] {
  if (!validateName(collection)) throw new Error("Invalid collection name");
  const parsed = parseFilterExpr(filterExpr);
  if (!parsed) return [];
  const cap = Math.max(1, Math.min(10_000, Math.floor(limit) || 1000));

  if (parsed.values.length === 0) return [];
  if (refIds !== null) {
    if (refIds.length === 0) return [];
    for (const r of refIds) {
      if (!validateRefId(r)) throw new Error(`Invalid ref id: ${r}`);
    }
  }

  const placeholders = parsed.values.map(() => "?").join(",");
  let sql = `SELECT pc.* FROM plugin_chunks pc
              WHERE pc.collection = ?
                AND pc.${parsed.column} IN (${placeholders})`;
  const args: (string | number)[] = [collection, ...parsed.values];
  if (refIds !== null) {
    const refPhs = refIds.map(() => "?").join(",");
    sql += ` AND EXISTS (
               SELECT 1 FROM plugin_ref_chunks rc
                WHERE rc.collection = pc.collection
                  AND rc.chunk_id = pc.chunk_id
                  AND rc.ref_id IN (${refPhs})
             )`;
    args.push(...refIds);
  }
  sql += ` LIMIT ?`;
  args.push(cap);
  const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];

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

// ── GC ──────────────────────────────────────────────────────────────────────

/**
 * Drop chunks (and their vectors) not referenced by any ref overlay. Safe
 * to run concurrently with writes — upserts always run inside a transaction
 * that writes both plugin_chunks and the vec row atomically, and overlay
 * updates happen in their own transaction that completes before this GC
 * observes the chunk as orphan.
 */
export function gcOrphanedChunks(): { chunksRemoved: number; vecRemoved: number } {
  requireVec();

  // Group orphan chunks by dimension so we can hit the right vec table.
  const orphans = db
    .prepare(
      `SELECT pc.rowid AS rowid, pc.collection AS collection, c.dimension AS dimension
         FROM plugin_chunks pc
         JOIN plugin_collections c ON c.name = pc.collection
        WHERE NOT EXISTS (
          SELECT 1 FROM plugin_ref_chunks rc
           WHERE rc.collection = pc.collection AND rc.chunk_id = pc.chunk_id
        )`,
    )
    .all() as { rowid: number; collection: string; dimension: number }[];

  if (orphans.length === 0) return { chunksRemoved: 0, vecRemoved: 0 };

  const byDim = new Map<number, number[]>();
  for (const o of orphans) {
    if (!byDim.has(o.dimension)) byDim.set(o.dimension, []);
    byDim.get(o.dimension)!.push(o.rowid);
  }

  let chunksRemoved = 0;
  let vecRemoved = 0;
  const tx = db.transaction(() => {
    for (const [dim, rowids] of byDim) {
      const vecTable = vecTableName(dim);
      const CAP = 500;
      for (let i = 0; i < rowids.length; i += CAP) {
        const slice = rowids.slice(i, i + CAP);
        const phs = slice.map(() => "?").join(",");
        const vecRes = db
          .prepare(`DELETE FROM ${vecTable} WHERE rowid IN (${phs})`)
          .run(...slice);
        vecRemoved += (vecRes as { changes?: number }).changes ?? 0;
        const chunkRes = db
          .prepare(`DELETE FROM plugin_chunks WHERE rowid IN (${phs})`)
          .run(...slice);
        chunksRemoved += (chunkRes as { changes?: number }).changes ?? 0;
      }
    }
  });
  tx();
  return { chunksRemoved, vecRemoved };
}
