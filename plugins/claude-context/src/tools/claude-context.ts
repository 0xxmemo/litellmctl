/**
 * claude-context tools: index_codebase, search_code, get_indexing_status, clear_index.
 *
 * File I/O happens here (on the user's machine). All state — job status, chunk
 * vectors — is written directly to the gateway. No local snapshot files.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ── Config ────────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "local/nomic-embed-text";
const EMBEDDING_DIMENSIONS = 512;
const CHUNK_LINES = 150;
const CHUNK_OVERLAP = 30;
const EMBED_BATCH_SIZE = 32;
const PROGRESS_INTERVAL_MS = 2000;
const MAX_FILE_BYTES = 512 * 1024; // skip files >512 KB

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".cs",
  ".cpp", ".c", ".cc", ".h", ".hpp",
  ".rb", ".php", ".swift", ".kt", ".scala",
  ".md", ".mdx", ".yaml", ".yml", ".toml",
  ".sh", ".bash", ".zsh", ".sql", ".graphql",
  ".proto", ".tf", ".hcl", ".vue", ".svelte",
]);

const DEFAULT_IGNORES = [
  "node_modules", ".git", "__pycache__", ".venv", "venv",
  "dist", "build", ".next", ".nuxt", "coverage", ".cache",
  ".turbo", ".parcel-cache", "target", ".gradle", "vendor",
  "*.lock", "*.min.js", "*.min.css",
];

// ── Gateway client ─────────────────────────────────────────────────────────────

interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
}

async function gatewayFetch(
  config: GatewayConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function upsertJob(
  config: GatewayConfig,
  job: {
    path: string;
    collection: string;
    status: "indexing" | "indexed" | "failed";
    percentage?: number;
    error?: string;
    total_files?: number;
    indexed_files?: number;
    total_chunks?: number;
  },
): Promise<void> {
  await gatewayFetch(config, "POST", "/api/plugins/claude-context/jobs", job);
}

async function embedBatch(
  config: GatewayConfig,
  texts: string[],
): Promise<number[][]> {
  const res = await gatewayFetch(config, "POST", "/v1/embeddings", {
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Embedding error ${res.status}: ${msg}`);
  }
  const data = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function pushChunks(
  config: GatewayConfig,
  absPath: string,
  documents: Array<{
    id: string;
    vector: number[];
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    fileExtension: string;
    metadata: Record<string, unknown>;
  }>,
): Promise<void> {
  const res = await gatewayFetch(config, "POST", "/api/plugins/claude-context/chunks", {
    path: absPath,
    documents,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Chunk push error ${res.status}: ${msg}`);
  }
}

// ── Smart path filtering via LLM ──────────────────────────────────────────────

async function getAgentExclusions(
  config: GatewayConfig,
  rootPath: string,
): Promise<string[]> {
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    const tree = entries.map((e) => `${e.isDirectory() ? "d" : "f"}  ${e.name}`).join("\n");

    const res = await gatewayFetch(config, "POST", "/v1/chat/completions", {
      model: "lite",
      messages: [
        {
          role: "user",
          content:
            `Top-level entries of a codebase to be indexed for semantic code search:\n\n${tree}\n\n` +
            `Return a JSON array of directory/file name patterns to EXCLUDE (build artifacts, ` +
            `generated files, dependencies, large data files, test fixtures with binary data). ` +
            `Only the JSON array, no other text.`,
        },
      ],
      max_tokens: 300,
    });

    if (!res.ok) return [];
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    const match = content.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const patterns = JSON.parse(match[0]);
    return Array.isArray(patterns)
      ? patterns.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

// ── File walking & chunking ────────────────────────────────────────────────────

function loadIgnorePatterns(rootPath: string, agentExclusions: string[]): string[] {
  const patterns = [...DEFAULT_IGNORES, ...agentExclusions];
  const gitignorePath = path.join(rootPath, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const lines = fs.readFileSync(gitignorePath, "utf-8").split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (t && !t.startsWith("#") && !t.startsWith("!")) patterns.push(t);
    }
  }
  return patterns;
}

function shouldIgnore(relPath: string, _name: string, patterns: string[]): boolean {
  const parts = relPath.split(path.sep);
  return patterns.some((p) => {
    const pat = p.replace(/\/$/, "");
    if (pat.includes("/")) return relPath.startsWith(pat) || relPath === pat;
    return parts.some((part) => {
      if (pat.includes("*")) {
        const re = new RegExp(
          "^" + pat.replace(/\./g, "\\.").replace(/\*/g, "[^/]*") + "$",
        );
        return re.test(part);
      }
      return part === pat;
    });
  });
}

function* walkDir(
  dirPath: string,
  rootPath: string,
  patterns: string[],
): Generator<string, void, undefined> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    const rel = path.relative(rootPath, full);
    if (shouldIgnore(rel, entry.name, patterns)) continue;
    if (entry.isDirectory()) {
      yield* walkDir(full, rootPath, patterns);
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

export function collectionName(absPath: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(absPath)
    .digest("hex")
    .slice(0, 16);
  return `code_chunks_${hash}`;
}

function chunkFile(
  absPath: string,
  relPath: string,
  content: string,
  ext: string,
): Array<{
  id: string;
  content: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  extension: string;
}> {
  const lines = content.split("\n");
  const chunks: ReturnType<typeof chunkFile> = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join("\n");
    if (text.trim().length === 0) { if (end >= lines.length) break; continue; }
    const id = crypto
      .createHash("sha256")
      .update(`${absPath}|${relPath}|${start}`)
      .digest("hex")
      .slice(0, 32);
    chunks.push({ id, content: text, relativePath: relPath, startLine: start + 1, endLine: end, extension: ext });
    if (end >= lines.length) break;
  }
  return chunks;
}

// ── Background indexing ────────────────────────────────────────────────────────

export async function runIndexing(
  config: GatewayConfig,
  absPath: string,
  collection: string,
): Promise<void> {
  const now = () => Date.now();

  async function updateJob(
    fields: Partial<{
      status: "indexing" | "indexed" | "failed";
      percentage: number;
      error: string;
      total_files: number;
      indexed_files: number;
      total_chunks: number;
    }>,
  ): Promise<void> {
    try {
      await upsertJob(config, { path: absPath, collection, status: "indexing", ...fields } as Parameters<typeof upsertJob>[1]);
    } catch {
      // progress updates are best-effort
    }
  }

  try {
    const agentExclusions = await getAgentExclusions(config, absPath);
    const ignorePatterns = loadIgnorePatterns(absPath, agentExclusions);

    const files: string[] = [];
    for (const f of walkDir(absPath, absPath, ignorePatterns)) files.push(f);

    await updateJob({ total_files: files.length });

    let indexedFiles = 0;
    let totalChunks = 0;
    let lastSave = now();

    const pendingContents: string[] = [];
    const pendingMeta: Array<{
      id: string;
      relativePath: string;
      startLine: number;
      endLine: number;
      extension: string;
    }> = [];

    async function flush(): Promise<void> {
      if (pendingContents.length === 0) return;
      const vectors = await embedBatch(config, pendingContents);
      const docs = pendingMeta.map((m, i) => ({
        id: m.id,
        vector: vectors[i],
        content: pendingContents[i],
        relativePath: m.relativePath,
        startLine: m.startLine,
        endLine: m.endLine,
        fileExtension: m.extension,
        metadata: { codebasePath: absPath },
      }));
      await pushChunks(config, absPath, docs);
      totalChunks += docs.length;
      pendingContents.length = 0;
      pendingMeta.length = 0;
    }

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      const relPath = path.relative(absPath, filePath);
      const ext = path.extname(filePath);

      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = fs.readFileSync(filePath, "utf-8");
        const chunks = chunkFile(absPath, relPath, content, ext);
        for (const chunk of chunks) {
          pendingContents.push(chunk.content);
          pendingMeta.push(chunk);
          if (pendingContents.length >= EMBED_BATCH_SIZE) await flush();
        }
        indexedFiles++;
      } catch {
        // skip unreadable files
      }

      const t = now();
      if (t - lastSave >= PROGRESS_INTERVAL_MS) {
        await flush();
        const pct = Math.round(((i + 1) / files.length) * 95);
        await updateJob({ percentage: pct, indexed_files: indexedFiles });
        lastSave = t;
      }
    }

    await flush();
    await upsertJob(config, {
      path: absPath,
      collection,
      status: "indexed",
      percentage: 100,
      indexed_files: indexedFiles,
      total_chunks: totalChunks,
    });
  } catch (err: any) {
    await upsertJob(config, {
      path: absPath,
      collection,
      status: "failed",
      error: err?.message ?? String(err),
    }).catch(() => {});
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const claudeContextToolDefs = [
  {
    name: "index_codebase",
    description:
      "Index a local codebase directory for semantic search. Provide an absolute path. " +
      "Indexing runs in the background — use get_indexing_status to check progress.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the codebase directory." },
        force: { type: "boolean", description: "Force re-index even if already indexed.", default: false },
      },
      required: ["path"],
    },
  },
  {
    name: "search_code",
    description:
      "Search an indexed codebase using natural language. " +
      "Use for: finding implementations, understanding patterns, locating related code.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the codebase." },
        query: { type: "string", description: "Natural language search query." },
        limit: { type: "number", default: 10, maximum: 50 },
      },
      required: ["path", "query"],
    },
  },
  {
    name: "get_indexing_status",
    description: "Check indexing progress for a codebase path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the codebase." },
      },
      required: ["path"],
    },
  },
  {
    name: "clear_index",
    description: "Remove the search index for a codebase.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the codebase." },
      },
      required: ["path"],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

export async function handleClaudeContextTool(
  name: string,
  args: Record<string, unknown>,
  config: GatewayConfig,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  function text(t: string) {
    return { content: [{ type: "text", text: t }] };
  }
  function err(t: string) {
    return { content: [{ type: "text", text: t }], isError: true };
  }

  switch (name) {
    case "index_codebase": {
      const absPath = args.path as string;
      const force = (args.force as boolean) ?? false;

      if (!absPath || typeof absPath !== "string") return err("path required");
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
        return err(`Path '${absPath}' is not a directory`);
      }

      // Check existing job state on the gateway
      const statusRes = await gatewayFetch(
        config,
        "GET",
        `/api/plugins/claude-context/jobs?path=${encodeURIComponent(absPath)}`,
      );
      if (statusRes.ok) {
        const existing = (await statusRes.json()) as { status?: string };
        if (existing.status === "indexing" && !force) {
          return err(`Already indexing '${absPath}'. Use force=true to restart.`);
        }
      }

      const collection = collectionName(absPath);

      if (force) {
        // DELETE /jobs drops both the vectordb collection and the job record.
        await gatewayFetch(
          config,
          "DELETE",
          `/api/plugins/claude-context/jobs?path=${encodeURIComponent(absPath)}`,
        ).catch(() => {});
      }

      await upsertJob(config, {
        path: absPath,
        collection,
        status: "indexing",
        percentage: 0,
      });

      // Fire-and-forget background indexing
      runIndexing(config, absPath, collection).catch(console.error);

      return text(`Started indexing '${absPath}'. Use get_indexing_status to track progress.`);
    }

    case "search_code": {
      const absPath = args.path as string;
      const query = args.query as string;
      const limit = (args.limit as number) ?? 10;

      if (!absPath) return err("path required");
      if (!query) return err("query required");

      const res = await gatewayFetch(config, "POST", "/api/plugins/claude-context/search", {
        path: absPath,
        query,
        limit,
      });

      if (res.status === 404) return err(`Codebase '${absPath}' is not indexed. Run index_codebase first.`);
      if (!res.ok) return err(`Search failed: ${res.status}`);

      const data = (await res.json()) as {
        results: Array<{
          document: {
            relativePath: string;
            startLine: number;
            endLine: number;
            content: string;
            fileExtension: string;
          };
          score: number;
        }>;
        indexing: boolean;
      };

      if (data.results.length === 0) {
        const note = data.indexing ? " (indexing still in progress — more results may appear later)" : "";
        return text(`No results found for "${query}"${note}`);
      }

      const formatted = data.results
        .map((r, i) => {
          const lang = r.document.fileExtension.replace(".", "");
          return (
            `${i + 1}. ${r.document.relativePath}:${r.document.startLine}-${r.document.endLine}\n` +
            `\`\`\`${lang}\n${r.document.content}\n\`\`\``
          );
        })
        .join("\n\n");

      const note = data.indexing
        ? "\n\n⚠️ Indexing still in progress — results may be incomplete."
        : "";

      return text(`Found ${data.results.length} results for "${query}":\n\n${formatted}${note}`);
    }

    case "get_indexing_status": {
      const absPath = args.path as string;
      if (!absPath) return err("path required");

      const res = await gatewayFetch(
        config,
        "GET",
        `/api/plugins/claude-context/jobs?path=${encodeURIComponent(absPath)}`,
      );

      if (res.status === 404) return text(`'${absPath}' is not indexed.`);
      if (!res.ok) return err(`Status check failed: ${res.status}`);

      const job = (await res.json()) as {
        status: string;
        percentage: number;
        indexed_files?: number;
        total_files?: number;
        total_chunks?: number;
        error?: string;
        updated_at: number;
      };

      const ago = Math.round((Date.now() - job.updated_at) / 1000);
      const since = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;

      if (job.status === "indexed") {
        return text(
          `✅ '${absPath}' is fully indexed.\n` +
            `Files: ${job.indexed_files ?? "?"} | Chunks: ${job.total_chunks ?? "?"} | Updated ${since}`,
        );
      }
      if (job.status === "indexing") {
        const pct = Math.round(job.percentage);
        const progress = job.total_files
          ? ` (${job.indexed_files ?? 0}/${job.total_files} files)`
          : "";
        return text(`🔄 Indexing in progress: ${pct}%${progress} — last update ${since}`);
      }
      if (job.status === "failed") {
        return text(`❌ Indexing failed: ${job.error ?? "unknown error"}\nRun index_codebase to retry.`);
      }

      return text(`Unknown status: ${job.status}`);
    }

    case "clear_index": {
      const absPath = args.path as string;
      if (!absPath) return err("path required");

      const res = await gatewayFetch(
        config,
        "DELETE",
        `/api/plugins/claude-context/jobs?path=${encodeURIComponent(absPath)}`,
      );
      if (res.status === 404) return text(`'${absPath}' is not indexed.`);
      if (!res.ok) return err(`Clear failed: ${res.status}`);

      return text(`Cleared index for '${absPath}'.`);
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
}
