/**
 * Shared client-side sync helpers used by both `claude-context` (code) and
 * `docs-context` (documentation) tool modules.
 *
 * Pure extraction from tools/claude-context.ts — every helper here was previously
 * defined inline there. The only addition is a `pluginPath` parameter on the
 * gateway calls so the same code talks to /api/plugins/claude-context/* OR
 * /api/plugins/docs-context/* depending on the caller. Behaviour is otherwise
 * identical.
 */

import * as crypto from "crypto";

// ── Shared config ─────────────────────────────────────────────────────────────

export const EMBEDDING_MODEL = "bedrock/titan-embed-v2";
export const EMBEDDING_DIMENSIONS = 1024;
export const CHUNK_LINES = 150;
export const CHUNK_OVERLAP = 30;
export const MAX_CHUNK_CHARS = 7500;
export const EMBED_BATCH_SIZE = 32;
export const EXISTS_BATCH_SIZE = 800;
export const PROGRESS_INTERVAL_MS = 2000;
export const MAX_FILE_BYTES = 512 * 1024;

// ── Gateway client ────────────────────────────────────────────────────────────

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Path prefix for the plugin's HTTP routes — e.g. "/api/plugins/claude-context"
 * or "/api/plugins/docs-context". Passed alongside GatewayConfig so the same
 * helpers can target either pipeline without duplication.
 */
export type PluginPath = string;

export async function gatewayFetch(
  config: GatewayConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Embed text builder ────────────────────────────────────────────────────────

export function buildEmbedText(relPath: string, content: string): string {
  return `// file: ${relPath}\n\n${content}`;
}

// ── Embedding (batch + single with bisection on context-window 400) ───────────

export async function embedOne(config: GatewayConfig, text: string): Promise<number[]> {
  const res = await gatewayFetch(config, "POST", "/v1/embeddings", {
    model: EMBEDDING_MODEL,
    input: [text],
    dimensions: EMBEDDING_DIMENSIONS,
  });
  if (res.ok) {
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }
  const body = await res.text().catch(() => "");
  const isContextWindow = res.status === 400 && /Too many input tokens|context.?window/i.test(body);
  if (!isContextWindow || text.length <= 500) {
    throw new Error(`Embedding error ${res.status}: ${body}`);
  }
  const mid = Math.floor(text.length / 2);
  const [left, right] = await Promise.all([
    embedOne(config, text.slice(0, mid)),
    embedOne(config, text.slice(mid)),
  ]);
  return averageVectors(left, right);
}

function averageVectors(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}

export async function embedBatch(config: GatewayConfig, texts: string[]): Promise<number[][]> {
  const res = await gatewayFetch(config, "POST", "/v1/embeddings", {
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  if (res.ok) {
    const data = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  const body = await res.text().catch(() => "");
  const isContextWindow = res.status === 400 && /Too many input tokens|context.?window/i.test(body);
  if (!isContextWindow) {
    throw new Error(`Embedding error ${res.status}: ${body}`);
  }
  const vectors: number[][] = [];
  for (const text of texts) vectors.push(await embedOne(config, text));
  return vectors;
}

// ── Chunk lifecycle (exists / push / overlay) ────────────────────────────────

export async function chunksExists(
  config: GatewayConfig,
  pluginPath: PluginPath,
  codebaseId: string,
  chunkIds: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let i = 0; i < chunkIds.length; i += EXISTS_BATCH_SIZE) {
    const slice = chunkIds.slice(i, i + EXISTS_BATCH_SIZE);
    const res = await gatewayFetch(config, "POST", `${pluginPath}/chunks/exists`, {
      codebaseId,
      chunkIds: slice,
    });
    if (!res.ok) continue;
    const data = (await res.json()) as { existing: string[] };
    for (const id of data.existing ?? []) existing.add(id);
  }
  return existing;
}

export interface PushDocument {
  id: string;
  vector: number[];
  content: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  fileExtension: string;
  metadata: Record<string, unknown>;
}

export async function pushChunks(
  config: GatewayConfig,
  pluginPath: PluginPath,
  codebaseId: string,
  documents: PushDocument[],
): Promise<void> {
  if (documents.length === 0) return;
  const res = await gatewayFetch(config, "POST", `${pluginPath}/chunks`, {
    codebaseId,
    documents,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Chunk push error ${res.status}: ${msg}`);
  }
}

export interface OverlayEntry {
  filePath: string;
  chunkIds: string[];
  fileHash?: string;
}

export async function setOverlay(
  config: GatewayConfig,
  pluginPath: PluginPath,
  codebaseId: string,
  branch: string,
  entries: OverlayEntry[],
): Promise<void> {
  const res = await gatewayFetch(config, "POST", `${pluginPath}/overlay`, {
    codebaseId,
    branch,
    entries,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Overlay update failed ${res.status}: ${msg}`);
  }
}

export async function fetchOverlay(
  config: GatewayConfig,
  pluginPath: PluginPath,
  codebaseId: string,
  branch: string,
): Promise<{ entries: OverlayEntry[]; headCommit: string | null }> {
  const res = await gatewayFetch(
    config,
    "GET",
    `${pluginPath}/overlay?codebaseId=${encodeURIComponent(codebaseId)}&branch=${encodeURIComponent(branch)}`,
  );
  if (res.status === 404) return { entries: [], headCommit: null };
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Overlay fetch failed ${res.status}: ${msg}`);
  }
  const data = (await res.json()) as {
    entries: OverlayEntry[];
    headCommit: string | null;
  };
  return { entries: data.entries ?? [], headCommit: data.headCommit ?? null };
}

// ── Collection naming + chunking ──────────────────────────────────────────────

export function collectionName(codebaseId: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(codebaseId)
    .digest("hex")
    .slice(0, 16);
  return `code_chunks_${hash}`;
}

export interface PendingChunk {
  id: string;
  content: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  extension: string;
}

export function chunkFile(
  relPath: string,
  content: string,
  ext: string,
): PendingChunk[] {
  const lines = content.split("\n");
  const chunks: PendingChunk[] = [];

  const pushChunk = (
    startLine: number,
    endLine: number,
    text: string,
    charOffset: number,
  ): void => {
    const idInput =
      charOffset === 0
        ? `${relPath}|${startLine}|${text}`
        : `${relPath}|${startLine}|co${charOffset}|${text}`;
    const id = crypto.createHash("sha256").update(idInput).digest("hex").slice(0, 32);
    chunks.push({
      id,
      content: text,
      relativePath: relPath,
      startLine,
      endLine,
      extension: ext,
    });
  };

  const emit = (start: number, end: number): void => {
    const text = lines.slice(start, end).join("\n");
    if (text.trim().length === 0) return;

    if (text.length <= MAX_CHUNK_CHARS) {
      pushChunk(start + 1, end, text, 0);
      return;
    }

    if (end - start > 1) {
      const mid = Math.floor((start + end) / 2);
      emit(start, mid);
      emit(mid, end);
      return;
    }

    for (let off = 0; off < text.length; off += MAX_CHUNK_CHARS) {
      const sub = text.slice(off, off + MAX_CHUNK_CHARS);
      if (sub.trim().length === 0) continue;
      pushChunk(start + 1, end, sub, off);
    }
  };

  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    emit(start, end);
    if (end >= lines.length) break;
  }
  return chunks;
}
