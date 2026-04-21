/**
 * claude-context tools: index_codebase, search_code, get_indexing_status, clear_index.
 *
 * Identity is derived from git on every invocation:
 *   - codebaseId = normalized `git remote get-url origin` → one collection per repo,
 *     shared across users/machines/checkouts.
 *   - branch     = `git rev-parse --abbrev-ref HEAD`.
 *   - The shared chunk store is overlaid with a per-branch ref in plugin_ref_chunks,
 *     so search results are always scoped to the caller's current branch.
 *
 * File I/O happens here (on the user's machine). Embedding, chunk storage, and
 * overlay state all live on the gateway.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";

// ── Config ────────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "local/nomic-embed-text";
const EMBEDDING_DIMENSIONS = 512;
const CHUNK_LINES = 150;
const CHUNK_OVERLAP = 30;
const EMBED_BATCH_SIZE = 32;
const EXISTS_BATCH_SIZE = 800;
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
  return fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

interface JobUpdate {
  codebaseId: string;
  branch: string;
  collection: string;
  status: "indexing" | "indexed" | "failed";
  percentage?: number;
  head_commit?: string | null;
  error?: string;
  total_files?: number;
  indexed_files?: number;
  total_chunks?: number;
}

async function upsertJob(config: GatewayConfig, job: JobUpdate): Promise<void> {
  await gatewayFetch(config, "POST", "/api/plugins/claude-context/jobs", job);
}

async function embedBatch(config: GatewayConfig, texts: string[]): Promise<number[][]> {
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

async function chunksExists(
  config: GatewayConfig,
  codebaseId: string,
  chunkIds: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let i = 0; i < chunkIds.length; i += EXISTS_BATCH_SIZE) {
    const slice = chunkIds.slice(i, i + EXISTS_BATCH_SIZE);
    const res = await gatewayFetch(config, "POST", "/api/plugins/claude-context/chunks/exists", {
      codebaseId,
      chunkIds: slice,
    });
    if (!res.ok) continue; // non-fatal — we'll just re-embed
    const data = (await res.json()) as { existing: string[] };
    for (const id of data.existing ?? []) existing.add(id);
  }
  return existing;
}

async function pushChunks(
  config: GatewayConfig,
  codebaseId: string,
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
  if (documents.length === 0) return;
  const res = await gatewayFetch(config, "POST", "/api/plugins/claude-context/chunks", {
    codebaseId,
    documents,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Chunk push error ${res.status}: ${msg}`);
  }
}

async function setOverlay(
  config: GatewayConfig,
  codebaseId: string,
  branch: string,
  entries: Array<{ filePath: string; chunkIds: string[] }>,
): Promise<void> {
  const res = await gatewayFetch(config, "POST", "/api/plugins/claude-context/overlay", {
    codebaseId,
    branch,
    entries,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Overlay update failed ${res.status}: ${msg}`);
  }
}

// ── Git identity resolution ────────────────────────────────────────────────────

export interface GitIdentity {
  codebaseId: string;
  branch: string;
  headCommit: string;
  isDirty: boolean;
}

function gitCmd(repo: string, args: string[]): string | null {
  try {
    return execSync(`git ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
      cwd: repo,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse a git remote URL into a stable, lowercase `host/org/repo` identifier.
 * Returns null for anything we don't recognize or that doesn't look safe.
 *
 * Examples:
 *   git@github.com:org/repo.git        → github.com/org/repo
 *   https://github.com/org/repo        → github.com/org/repo
 *   https://user@gitlab.com/org/x.git  → gitlab.com/org/x
 *   ssh://git@host:22/~user/repo.git   → host/user/repo
 */
export function normalizeOrigin(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim();

  // scp-like: git@host:path  →  host/path
  const scp = s.match(/^[^@:\s]+@([^:\s]+):(.+)$/);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z]+:\/\//i, ""); // strip scheme
    s = s.replace(/^[^@\/\s]+@/, ""); // strip user@
  }
  s = s.replace(/:\d+\//, "/"); // strip :port
  s = s.replace(/\.git\/?$/i, "");
  s = s.replace(/\/+$/g, "");
  s = s.replace(/~/g, "");
  s = s.toLowerCase();

  if (!/^[a-z0-9][a-z0-9._\/-]{2,199}$/.test(s)) return null;
  return s;
}

export function resolveGitIdentity(absPath: string): GitIdentity | null {
  const insideRepo = gitCmd(absPath, ["rev-parse", "--is-inside-work-tree"]);
  if (insideRepo !== "true") return null;

  const originRaw = gitCmd(absPath, ["remote", "get-url", "origin"]);
  if (!originRaw) return null;
  const codebaseId = normalizeOrigin(originRaw);
  if (!codebaseId) return null;

  const branchRaw = gitCmd(absPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headCommit = gitCmd(absPath, ["rev-parse", "HEAD"]);
  if (!headCommit) return null;

  let branch = branchRaw ?? "detached";
  if (branch === "HEAD" || branch === "detached") {
    branch = `detached@${headCommit.slice(0, 12)}`;
  }
  if (!/^[A-Za-z0-9_:.\/@-]{1,128}$/.test(branch)) return null;

  const dirty = gitCmd(absPath, ["status", "--porcelain"]);
  const isDirty = dirty !== null && dirty.length > 0;

  return { codebaseId, branch, headCommit, isDirty };
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

const SCOPE_TREE_MAX_DEPTH = 4;
const SCOPE_TREE_PER_DIR_CAP = 60;
const SCOPE_TREE_MAX_BYTES = 16 * 1024;

function buildScopeTree(rootPath: string): string {
  const lines: string[] = [];
  let byteBudget = SCOPE_TREE_MAX_BYTES;

  const walk = (dirPath: string, relPath: string, depth: number): void => {
    if (depth > SCOPE_TREE_MAX_DEPTH || byteBudget <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !shouldIgnore(
        relPath ? path.posix.join(relPath, e.name) : e.name,
        e.name,
        DEFAULT_IGNORES,
      ))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, SCOPE_TREE_PER_DIR_CAP);

    const fileCount = entries.filter((e) => e.isFile()).length;

    for (const d of dirs) {
      const childRel = relPath ? path.posix.join(relPath, d.name) : d.name;
      const childAbs = path.join(dirPath, d.name);
      let childEntries = 0;
      try {
        childEntries = fs.readdirSync(childAbs).length;
      } catch {
        // ignore
      }
      const indent = "  ".repeat(depth);
      const line = `${indent}${childRel}/  (${childEntries} entries)\n`;
      if (line.length > byteBudget) {
        byteBudget = 0;
        return;
      }
      lines.push(line);
      byteBudget -= line.length;
      walk(childAbs, childRel, depth + 1);
      if (byteBudget <= 0) return;
    }

    if (depth === 0 && fileCount > 0) {
      const line = `(root has ${fileCount} top-level files)\n`;
      if (line.length <= byteBudget) {
        lines.push(line);
        byteBudget -= line.length;
      }
    }
  };

  walk(rootPath, "", 0);
  return lines.join("");
}

async function getAgentExclusions(
  config: GatewayConfig,
  rootPath: string,
): Promise<string[]> {
  try {
    const tree = buildScopeTree(rootPath);
    if (!tree) return [];

    const res = await gatewayFetch(config, "POST", "/v1/chat/completions", {
      model: "lite",
      messages: [
        {
          role: "user",
          content:
            `Directory tree (up to depth ${SCOPE_TREE_MAX_DEPTH}) of a codebase to be indexed ` +
            `for semantic code search. Entry counts are shown to help spot large subtrees:\n\n${tree}\n` +
            `Return a JSON array of patterns to EXCLUDE from indexing. Exclude: build artifacts, ` +
            `generated code, vendored dependencies, large data/fixture dirs, docs/cookbook/examples ` +
            `that aren't source, and any deep subtrees that look like test fixtures or experimental ` +
            `scratch code. Patterns can be a base name (e.g. "cookbook") OR a path prefix ` +
            `(e.g. "litellm/tests", "litellm/docs"). Prefer path prefixes when excluding a specific ` +
            `subtree inside a larger source dir. Only the JSON array, no other text.`,
        },
      ],
      max_tokens: 800,
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

export function collectionName(codebaseId: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(codebaseId)
    .digest("hex")
    .slice(0, 16);
  return `code_chunks_${hash}`;
}

interface PendingChunk {
  id: string;
  content: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  extension: string;
}

/**
 * Content-addressed chunk IDs. Same content at the same rel-path+line yields
 * the same ID across users, machines, and branches — so unchanged files reuse
 * existing embeddings when switching branches.
 */
function chunkFile(
  relPath: string,
  content: string,
  ext: string,
): PendingChunk[] {
  const lines = content.split("\n");
  const chunks: PendingChunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join("\n");
    if (text.trim().length === 0) {
      if (end >= lines.length) break;
      continue;
    }
    const id = crypto
      .createHash("sha256")
      .update(`${relPath}|${start + 1}|${text}`)
      .digest("hex")
      .slice(0, 32);
    chunks.push({
      id,
      content: text,
      relativePath: relPath,
      startLine: start + 1,
      endLine: end,
      extension: ext,
    });
    if (end >= lines.length) break;
  }
  return chunks;
}

// ── Sync (diff-based indexing) ─────────────────────────────────────────────────

export interface SyncResult {
  shortCircuit: boolean;
  totalChunks: number;
  embeddedChunks: number;
  reusedChunks: number;
  totalFiles: number;
}

/**
 * Diff-based sync. Walks the working tree, computes the desired chunk set,
 * skips chunks that already live on the gateway, embeds only the missing
 * ones, and replaces the branch's ref overlay with the full (file → chunkIds)
 * map. Short-circuits when head_commit matches and the tree is clean.
 */
export async function runSync(
  config: GatewayConfig,
  absPath: string,
  identity: GitIdentity,
): Promise<SyncResult> {
  const { codebaseId, branch, headCommit, isDirty } = identity;
  const collection = collectionName(codebaseId);
  const now = () => Date.now();

  // Short-circuit: head hasn't moved and working tree is clean.
  const existingJob = await gatewayFetch(
    config,
    "GET",
    `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(codebaseId)}&branch=${encodeURIComponent(branch)}`,
  );
  if (existingJob.ok) {
    const job = (await existingJob.json()) as { status?: string; head_commit?: string | null };
    if (
      job.status === "indexed" &&
      job.head_commit === headCommit &&
      !isDirty
    ) {
      return { shortCircuit: true, totalChunks: 0, embeddedChunks: 0, reusedChunks: 0, totalFiles: 0 };
    }
  }

  async function updateJob(fields: Partial<JobUpdate>): Promise<void> {
    try {
      await upsertJob(config, {
        codebaseId,
        branch,
        collection,
        status: "indexing",
        ...fields,
      });
    } catch {
      // progress updates are best-effort
    }
  }

  await updateJob({ percentage: 0 });

  const agentExclusions = await getAgentExclusions(config, absPath);
  const ignorePatterns = loadIgnorePatterns(absPath, agentExclusions);

  const files: string[] = [];
  for (const f of walkDir(absPath, absPath, ignorePatterns)) files.push(f);

  await updateJob({ total_files: files.length });

  // Walk + chunk everything up front. This gives us the desired overlay and
  // lets us dedupe against the gateway in a single round-trip.
  const allChunks: PendingChunk[] = [];
  const overlayByFile = new Map<string, string[]>();
  let indexedFiles = 0;

  for (const filePath of files) {
    const relPath = path.relative(absPath, filePath);
    const ext = path.extname(filePath);
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      const chunks = chunkFile(relPath, content, ext);
      if (chunks.length === 0) continue;
      for (const c of chunks) allChunks.push(c);
      overlayByFile.set(
        relPath,
        chunks.map((c) => c.id),
      );
      indexedFiles++;
    } catch {
      // skip unreadable files
    }
  }

  // Dedupe: ask the gateway which chunk IDs it already has.
  const existing = await chunksExists(
    config,
    codebaseId,
    allChunks.map((c) => c.id),
  );
  const missing = allChunks.filter((c) => !existing.has(c.id));
  const reused = allChunks.length - missing.length;

  await updateJob({
    indexed_files: indexedFiles,
    total_chunks: allChunks.length,
    percentage: missing.length === 0 ? 90 : 10,
  });

  // Embed + upload only the missing chunks.
  let embedded = 0;
  let lastProgress = now();
  for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
    const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedBatch(config, batch.map((c) => c.content));
    const docs = batch.map((c, idx) => ({
      id: c.id,
      vector: vectors[idx],
      content: c.content,
      relativePath: c.relativePath,
      startLine: c.startLine,
      endLine: c.endLine,
      fileExtension: c.extension,
      metadata: {},
    }));
    await pushChunks(config, codebaseId, docs);
    embedded += batch.length;

    const t = now();
    if (t - lastProgress >= PROGRESS_INTERVAL_MS) {
      const pct = Math.round(10 + (embedded / Math.max(missing.length, 1)) * 80);
      await updateJob({ percentage: pct });
      lastProgress = t;
    }
  }

  // Atomically replace the overlay for this (codebase, branch). Files that
  // disappeared from the working tree drop out automatically.
  const overlayEntries = Array.from(overlayByFile.entries()).map(([filePath, chunkIds]) => ({
    filePath,
    chunkIds,
  }));
  await setOverlay(config, codebaseId, branch, overlayEntries);

  await upsertJob(config, {
    codebaseId,
    branch,
    collection,
    status: "indexed",
    percentage: 100,
    head_commit: headCommit,
    indexed_files: indexedFiles,
    total_chunks: allChunks.length,
    total_files: files.length,
  });

  return {
    shortCircuit: false,
    totalChunks: allChunks.length,
    embeddedChunks: embedded,
    reusedChunks: reused,
    totalFiles: files.length,
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const claudeContextToolDefs = [
  {
    name: "index_codebase",
    description:
      "Index a git repository for semantic search. Uses the origin remote as the codebase identity " +
      "(so a repo is indexed once across all users) and overlays a per-branch view of the working " +
      "tree. Unchanged files reuse existing embeddings — only changed content is re-embedded.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the local checkout. Must be inside a git repo with an 'origin' remote.",
        },
        force: {
          type: "boolean",
          description: "Force re-sync even if HEAD hasn't moved and the working tree is clean.",
          default: false,
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_code",
    description:
      "Search the caller's current branch of an indexed codebase using natural language. " +
      "Results are filtered to the branch's working-tree overlay — code that exists on other branches " +
      "but not on this one will not appear. Use for: finding implementations, understanding patterns.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the local checkout." },
        query: { type: "string", description: "Natural language search query." },
        limit: { type: "number", default: 10, maximum: 50 },
      },
      required: ["path", "query"],
    },
  },
  {
    name: "get_indexing_status",
    description: "Check indexing progress for the current branch of a codebase.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the local checkout." },
      },
      required: ["path"],
    },
  },
  {
    name: "clear_index",
    description:
      "Remove the search index for a codebase. With scope='branch' (default) drops only the current " +
      "branch's overlay. With scope='codebase' drops the entire shared collection — affects all users.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the local checkout." },
        scope: { type: "string", enum: ["branch", "codebase"], default: "branch" },
      },
      required: ["path"],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

function identityErr(absPath: string): string {
  return (
    `'${absPath}' cannot be indexed: it must be inside a git repository with an 'origin' remote ` +
    `(run 'git remote -v' to check). Collection identity requires a stable upstream URL so the ` +
    `index can be shared across machines.`
  );
}

export async function handleClaudeContextTool(
  name: string,
  args: Record<string, unknown>,
  config: GatewayConfig,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const textRes = (t: string) => ({ content: [{ type: "text", text: t }] });
  const errRes = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });

  switch (name) {
    case "index_codebase": {
      const absPath = args.path as string;
      const force = (args.force as boolean) ?? false;

      if (!absPath || typeof absPath !== "string") return errRes("path required");
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
        return errRes(`Path '${absPath}' is not a directory`);
      }

      const identity = resolveGitIdentity(absPath);
      if (!identity) return errRes(identityErr(absPath));

      const collection = collectionName(identity.codebaseId);

      if (force) {
        await gatewayFetch(
          config,
          "DELETE",
          `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
        ).catch(() => {});
      }

      const statusRes = await gatewayFetch(
        config,
        "GET",
        `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
      );
      if (statusRes.ok) {
        const existing = (await statusRes.json()) as { status?: string };
        if (existing.status === "indexing" && !force) {
          return errRes(
            `Already indexing '${identity.codebaseId}@${identity.branch}'. Use force=true to restart.`,
          );
        }
      }

      await upsertJob(config, {
        codebaseId: identity.codebaseId,
        branch: identity.branch,
        collection,
        status: "indexing",
        percentage: 0,
      });

      // Fire-and-forget background indexing
      runSync(config, absPath, identity).catch(console.error);

      return textRes(
        `Started sync for '${identity.codebaseId}@${identity.branch}'. Use get_indexing_status to track progress.`,
      );
    }

    case "search_code": {
      const absPath = args.path as string;
      const query = args.query as string;
      const limit = (args.limit as number) ?? 10;

      if (!absPath) return errRes("path required");
      if (!query) return errRes("query required");

      const identity = resolveGitIdentity(absPath);
      if (!identity) return errRes(identityErr(absPath));

      const res = await gatewayFetch(config, "POST", "/api/plugins/claude-context/search", {
        codebaseId: identity.codebaseId,
        branch: identity.branch,
        query,
        limit,
      });

      if (res.status === 404) {
        return errRes(
          `'${identity.codebaseId}@${identity.branch}' is not indexed. Run index_codebase first.`,
        );
      }
      if (!res.ok) return errRes(`Search failed: ${res.status}`);

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
        return textRes(`No results found for "${query}"${note}`);
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

      return textRes(`Found ${data.results.length} results for "${query}":\n\n${formatted}${note}`);
    }

    case "get_indexing_status": {
      const absPath = args.path as string;
      if (!absPath) return errRes("path required");

      const identity = resolveGitIdentity(absPath);
      if (!identity) return errRes(identityErr(absPath));

      const res = await gatewayFetch(
        config,
        "GET",
        `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
      );

      if (res.status === 404) {
        return textRes(`'${identity.codebaseId}@${identity.branch}' is not indexed.`);
      }
      if (!res.ok) return errRes(`Status check failed: ${res.status}`);

      const job = (await res.json()) as {
        status: string;
        percentage: number;
        head_commit?: string | null;
        indexed_files?: number;
        total_files?: number;
        total_chunks?: number;
        error?: string;
        updated_at: number;
      };

      const ago = Math.round((Date.now() - job.updated_at) / 1000);
      const since = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
      const label = `${identity.codebaseId}@${identity.branch}`;

      if (job.status === "indexed") {
        const headMatches = job.head_commit === identity.headCommit;
        const dirtyNote = identity.isDirty ? " (working tree dirty — re-sync recommended)" : "";
        const driftNote = !headMatches ? " (HEAD has moved since last sync — re-sync recommended)" : "";
        return textRes(
          `✅ '${label}' is indexed.\n` +
            `Files: ${job.indexed_files ?? "?"} | Chunks: ${job.total_chunks ?? "?"} | Updated ${since}${dirtyNote}${driftNote}`,
        );
      }
      if (job.status === "indexing") {
        const pct = Math.round(job.percentage);
        const progress = job.total_files
          ? ` (${job.indexed_files ?? 0}/${job.total_files} files)`
          : "";
        return textRes(`🔄 Indexing in progress: ${pct}%${progress} — last update ${since}`);
      }
      if (job.status === "failed") {
        return textRes(`❌ Indexing failed: ${job.error ?? "unknown error"}\nRun index_codebase to retry.`);
      }

      return textRes(`Unknown status: ${job.status}`);
    }

    case "clear_index": {
      const absPath = args.path as string;
      const scope = (args.scope as string) ?? "branch";
      if (!absPath) return errRes("path required");

      const identity = resolveGitIdentity(absPath);
      if (!identity) return errRes(identityErr(absPath));

      const qs =
        scope === "codebase"
          ? `codebaseId=${encodeURIComponent(identity.codebaseId)}`
          : `codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`;

      const res = await gatewayFetch(
        config,
        "DELETE",
        `/api/plugins/claude-context/jobs?${qs}`,
      );
      if (res.status === 404) return textRes(`'${identity.codebaseId}' is not indexed.`);
      if (!res.ok) return errRes(`Clear failed: ${res.status}`);

      return textRes(
        scope === "codebase"
          ? `Cleared entire index for '${identity.codebaseId}' (all branches).`
          : `Cleared branch overlay for '${identity.codebaseId}@${identity.branch}'.`,
      );
    }

    default:
      return errRes(`Unknown tool: ${name}`);
  }
}
