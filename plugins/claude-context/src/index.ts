#!/usr/bin/env bun

/**
 * Entry point — runs in one of two modes:
 *   - MCP server (no argv)  — stdio MCP protocol, used by Claude Code as an MCP plugin
 *   - CLI (index|search|status subcommand) — used by hooks (session-start, prompt-search)
 *
 * Identity is derived from git on every call (origin remote → codebaseId,
 * HEAD → branch). The CLI silently exits when a path has no origin remote;
 * the MCP tools surface the same condition as an error because the model
 * invoked them explicitly.
 *
 * All state lives in the gateway — no local snapshot files.
 */

import * as fs from "fs";
import {
  claudeContextToolDefs,
  collectionName,
  handleClaudeContextTool,
  resolveGitIdentity,
  runSync,
} from "./tools/claude-context";

// ── Gateway credentials ───────────────────────────────────────────────────────

function resolveGatewayConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.GATEWAY_URL || process.env.LLM_GATEWAY_URL;
  const apiKey = process.env.GATEWAY_API_KEY || process.env.LLM_GATEWAY_API_KEY;
  if (!baseUrl || !apiKey) {
    process.stderr.write(
      "[ERR] Missing required env: GATEWAY_URL (or LLM_GATEWAY_URL) and GATEWAY_API_KEY (or LLM_GATEWAY_API_KEY)\n",
    );
    process.exit(1);
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

// ── Tool registry ─────────────────────────────────────────────────────────────

const allToolDefs = [
  ...claudeContextToolDefs,
];

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  config: { baseUrl: string; apiKey: string },
) {
  if (claudeContextToolDefs.some((t) => t.name === name)) {
    return handleClaudeContextTool(name, args, config);
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

// ── CLI mode (hooks) ──────────────────────────────────────────────────────────
//
// stdout is machine-readable JSON (piped through jq by hooks).
// stderr carries progress / debug.

async function runCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  const args: Record<string, string | number | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--path") args.path = argv[++i];
    else if (a === "--query") args.query = argv[++i];
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (a === "--force") args.force = true;
  }

  const config = resolveGatewayConfig();
  const log = (m: string) => process.stderr.write(`[cli] ${m}\n`);
  const emit = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

  if (!args.path) { log(`${sub}: --path required`); process.exit(1); }
  const absPath = String(args.path);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
    log(`${sub}: '${absPath}' is not a directory`);
    process.exit(1);
  }

  // Resolve identity once up front. No origin → silent exit for every subcommand;
  // hooks must never block on this or emit noise when run in a non-git repo.
  const identity = resolveGitIdentity(absPath);
  if (!identity) {
    log(`${absPath}: no git origin remote — skipping (shared index requires a stable upstream URL)`);
    if (sub === "search") process.exit(2); // prompt-search.sh treats 2 as not-indexed / silent
    process.exit(0);
  }

  try {
    if (sub === "index") {
      log(`sync ${identity.codebaseId}@${identity.branch} (head ${identity.headCommit.slice(0, 8)}${identity.isDirty ? ", dirty" : ""})`);

      if (args.force) {
        await fetch(
          `${config.baseUrl}/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${config.apiKey}` } },
        ).catch(() => {});
      } else {
        const existing = await gatewayGet(
          config,
          `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
        );
        if (existing.ok) {
          const job = (await existing.json()) as { status: string };
          if (job.status === "indexing") {
            emit({ skipped: true, reason: "already_indexing" });
            return;
          }
        }
      }

      // Signal handlers: flip the job to "failed" on clean termination so the
      // next run isn't blocked waiting for the gateway's staleness reaper.
      const collection = collectionName(identity.codebaseId);
      let interrupted = false;
      const markFailed = (reason: string): void => {
        if (interrupted) return;
        interrupted = true;
        gatewayPost(config, "/api/plugins/claude-context/jobs", {
          codebaseId: identity.codebaseId,
          branch: identity.branch,
          collection,
          status: "failed",
          error: reason,
        })
          .catch(() => {})
          .finally(() => process.exit(130));
      };
      const onSignal = (sig: NodeJS.Signals): void => markFailed(`interrupted by ${sig}`);
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);

      try {
        const result = await runSync(config, absPath, identity);
        if (result.shortCircuit) {
          log(`up-to-date (head ${identity.headCommit.slice(0, 8)}) — skipping`);
          emit({ done: true, shortCircuit: true });
        } else {
          log(
            `synced ${identity.codebaseId}@${identity.branch}: ` +
              `${result.embeddedChunks} embedded, ${result.reusedChunks} reused, ${result.totalFiles} files`,
          );
          emit({ done: true, ...result });
        }
      } catch (err) {
        emit({ error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      }
      return;
    }

    if (sub === "search") {
      if (!args.query) { log("search: --query required"); process.exit(1); }

      // Check job exists first — hook expects exit 2 when not indexed.
      const statusRes = await gatewayGet(
        config,
        `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
      );
      if (statusRes.status === 404) {
        log(`search: '${identity.codebaseId}@${identity.branch}' not indexed`);
        process.exit(2);
      }

      const searchRes = await gatewayPost(config, "/api/plugins/claude-context/search", {
        codebaseId: identity.codebaseId,
        branch: identity.branch,
        query: args.query,
        limit: args.limit ?? 5,
      });
      if (!searchRes.ok) {
        log(`search: gateway returned ${searchRes.status}`);
        process.exit(2);
      }
      const data = (await searchRes.json()) as {
        results: Array<{
          document: {
            content: string;
            relativePath: string;
            startLine: number;
            endLine: number;
            fileExtension: string;
          };
          score: number;
        }>;
      };
      emit({
        results: data.results.map((r) => ({
          relativePath: r.document.relativePath,
          startLine: r.document.startLine,
          endLine: r.document.endLine,
          language: r.document.fileExtension.replace(/^\./, ""),
          score: r.score,
          content: r.document.content,
        })),
      });
      return;
    }

    if (sub === "status") {
      const res = await gatewayGet(
        config,
        `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
      );
      if (res.status === 404) { emit({ status: "not_found" }); return; }
      emit(await res.json());
      return;
    }

    process.stderr.write(
      `Usage: bun src/index.ts {index|search|status} --path P [--query Q] [--limit N] [--force]\n`,
    );
    process.exit(1);
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function gatewayGet(
  config: { baseUrl: string; apiKey: string },
  path: string,
): Promise<Response> {
  return fetch(`${config.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
}

async function gatewayPost(
  config: { baseUrl: string; apiKey: string },
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// ── Mode dispatch ─────────────────────────────────────────────────────────────

// `collectionName` intentionally re-exported so downstream scripts can still
// derive the shared collection from a codebaseId without reaching into tools/.
void collectionName;

const argv = process.argv.slice(2);
if (argv.length > 0 && ["index", "search", "status"].includes(argv[0])) {
  await runCli(argv);
} else {
  // MCP server mode — redirect console to stderr so stdout stays clean for JSON-RPC.
  console.log = (...a: unknown[]) => process.stderr.write("[LOG] " + a.join(" ") + "\n");
  console.warn = (...a: unknown[]) => process.stderr.write("[WARN] " + a.join(" ") + "\n");
  console.error = (...a: unknown[]) => process.stderr.write("[ERR] " + a.join(" ") + "\n");

  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );

  const config = resolveGatewayConfig();
  const server = new Server(
    { name: "litellm-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allToolDefs }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    return dispatchTool(name, args as Record<string, unknown>, config);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
