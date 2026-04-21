/**
 * One-shot CLI subcommands sharing the plugin's Context machinery.
 *
 * Driven by hooks (session-start.sh, prompt-search.sh) so Claude Code can
 * autonomously index and serve relevant chunks without the model having to
 * explicitly call the MCP tools.
 *
 * stdout = machine-readable JSON. All progress / debug goes to stderr so the
 * caller (a hook) can pipe stdout straight into jq.
 */

import * as fs from 'fs';
import * as path from 'path';

import { Context } from './core/context';
import { GatewayVectorDatabase } from './core/vectordb/gateway-vectordb';
import { LiteLLMEmbedding } from './core/embedding/litellm-embedding';
import { LangChainCodeSplitter } from './core/splitter';
import { SnapshotManager } from './snapshot';
import { ensureAbsolutePath, truncateContent } from './utils';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './config';

// stderr-only logging — stdout is reserved for JSON output the hook will parse.
const log = (msg: string) => process.stderr.write(`[cli] ${msg}\n`);
const die = (code: number, msg: string) => {
    process.stderr.write(`[cli] ${msg}\n`);
    process.exit(code);
};

interface ParsedArgs {
    sub: string;
    path?: string;
    query?: string;
    limit?: number;
    force?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
    const sub = argv[0] || '';
    const out: ParsedArgs = { sub };
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--path') out.path = argv[++i];
        else if (a === '--query') out.query = argv[++i];
        else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
        else if (a === '--force') out.force = true;
    }
    return out;
}

function buildContext(): { context: Context; snapshot: SnapshotManager } {
    const baseUrl = process.env.LLM_GATEWAY_URL;
    const apiKey = process.env.LLM_GATEWAY_API_KEY;
    if (!baseUrl || !apiKey) {
        die(1, 'LLM_GATEWAY_URL and LLM_GATEWAY_API_KEY are required');
    }
    const embedding = new LiteLLMEmbedding({
        baseUrl: baseUrl!,
        apiKey: apiKey!,
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
    });
    const vectorDatabase = new GatewayVectorDatabase({
        baseUrl: baseUrl!,
        apiKey: apiKey!,
    });
    const context = new Context({
        embedding,
        vectorDatabase,
        codeSplitter: new LangChainCodeSplitter(1000, 200),
    });
    const snapshot = new SnapshotManager();
    snapshot.loadCodebaseSnapshot();
    return { context, snapshot };
}

function isOnAutoIndexBlocklist(absPath: string): boolean {
    const list = (process.env.CLAUDE_CONTEXT_AUTO_INDEX_BLOCKLIST || '').trim();
    if (!list) return false;
    return list
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .some((p) => absPath === p || absPath.startsWith(p + path.sep));
}

async function cmdIndex(args: ParsedArgs): Promise<number> {
    if (!args.path) die(1, 'index: --path is required');
    const absPath = ensureAbsolutePath(args.path!);

    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
        die(1, `index: '${absPath}' is not a directory`);
    }
    if (isOnAutoIndexBlocklist(absPath)) {
        log(`skipping ${absPath} — on CLAUDE_CONTEXT_AUTO_INDEX_BLOCKLIST`);
        process.stdout.write(JSON.stringify({ skipped: true, reason: 'blocklist' }) + '\n');
        return 0;
    }

    const { context, snapshot } = buildContext();
    const isIndexed = snapshot.getIndexedCodebases().includes(absPath);
    const vectorHasIndex = await context.hasIndex(absPath);

    // Incremental path: snapshot says indexed and the collection still exists.
    if (isIndexed && vectorHasIndex && !args.force) {
        log(`reindexByChange ${absPath}`);
        const stats = await context.reindexByChange(absPath, (p) =>
            log(`${p.phase} (${p.percentage}%)`),
        );
        process.stdout.write(JSON.stringify({ mode: 'incremental', ...stats }) + '\n');
        return 0;
    }

    // Full index path.
    log(`indexCodebase ${absPath}${args.force ? ' (force)' : ''}`);
    const stats = await context.indexCodebase(
        absPath,
        (p) => log(`${p.phase} (${p.percentage}%)`),
        args.force === true,
    );
    if (stats.indexedFiles > 0 || stats.totalChunks > 0) {
        snapshot.setCodebaseIndexed(absPath, stats);
        snapshot.saveCodebaseSnapshot();
    }
    process.stdout.write(JSON.stringify({ mode: 'full', ...stats }) + '\n');
    return 0;
}

async function cmdSearch(args: ParsedArgs): Promise<number> {
    if (!args.path) die(1, 'search: --path is required');
    if (!args.query) die(1, 'search: --query is required');
    const absPath = ensureAbsolutePath(args.path!);
    const limit = Math.max(1, Math.min(50, args.limit || 5));
    const maxChunkChars = parseInt(process.env.CLAUDE_CONTEXT_AUTO_SEARCH_MAX_CHARS || '800', 10);

    if (!fs.existsSync(absPath)) {
        log(`search: path missing — ${absPath}`);
        process.exit(2);
    }

    const { context, snapshot } = buildContext();
    const isIndexed = snapshot.getIndexedCodebases().includes(absPath);
    const vectorHasIndex = await context.hasIndex(absPath);
    if (!isIndexed && !vectorHasIndex) {
        log(`search: '${absPath}' not indexed — exit 2`);
        process.exit(2);
    }

    const results = await context.semanticSearch(absPath, args.query!, limit, 0.3);
    process.stdout.write(
        JSON.stringify({
            results: results.map((r) => ({
                relativePath: r.relativePath,
                startLine: r.startLine,
                endLine: r.endLine,
                language: r.language,
                score: r.score,
                content: truncateContent(r.content, maxChunkChars),
            })),
        }) + '\n',
    );
    return 0;
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
    if (!args.path) die(1, 'status: --path is required');
    const absPath = ensureAbsolutePath(args.path!);
    const { snapshot } = buildContext();
    const status = snapshot.getCodebaseStatus(absPath);
    const progress = snapshot.getIndexingProgress(absPath);
    const info = snapshot.getCodebaseInfo(absPath);
    process.stdout.write(JSON.stringify({ path: absPath, status, progress, info }) + '\n');
    return 0;
}

const HELP = `claude-context CLI

Subcommands (stdout = JSON, stderr = logs):
  index   --path P [--force]
  search  --path P --query Q [--limit N]
  status  --path P

Default (no subcommand) → stdio MCP server.
Required env: LLM_GATEWAY_URL, LLM_GATEWAY_API_KEY
`;

export async function runCli(argv: string[]): Promise<void> {
    const args = parseArgs(argv);
    let code = 0;
    try {
        switch (args.sub) {
            case 'index':  code = await cmdIndex(args); break;
            case 'search': code = await cmdSearch(args); break;
            case 'status': code = await cmdStatus(args); break;
            case 'help':
            case '--help':
            case '-h':
                process.stdout.write(HELP);
                break;
            default:
                process.stderr.write(`[cli] unknown subcommand: ${args.sub}\n${HELP}`);
                code = 1;
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[cli] error: ${msg}\n`);
        code = 1;
    }
    process.exit(code);
}
