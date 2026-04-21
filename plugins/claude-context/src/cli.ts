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
import * as os from 'os';
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

function buildContext(): {
    context: Context;
    snapshot: SnapshotManager;
    vectorDatabase: GatewayVectorDatabase;
} {
    // TODO: accept LITELLMCTL_URL / LITELLMCTL_API_KEY when we migrate env names.
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
    return { context, snapshot, vectorDatabase };
}

function resolveStateDir(): string {
    return (
        process.env.CLAUDE_CONTEXT_STATE_DIR ||
        path.join(os.homedir(), '.litellm', 'plugin-state', 'claude-context')
    );
}

/**
 * PID-file lock for concurrent index runs on the same codebase. Returns a
 * release callback if acquired, or null if another live process holds it.
 */
function acquireIndexLock(lockPath: string): (() => void) | null {
    try {
        if (fs.existsSync(lockPath)) {
            const raw = fs.readFileSync(lockPath, 'utf8').trim();
            const pid = parseInt(raw, 10);
            if (Number.isFinite(pid) && pid > 0) {
                try {
                    process.kill(pid, 0);
                    return null; // holder is alive
                } catch {
                    // stale — fall through to overwrite
                }
            }
        }
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, String(process.pid));
    } catch (err) {
        log(`index-lock: unable to acquire (${err instanceof Error ? err.message : String(err)}) — proceeding without`);
        return () => {};
    }

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        try {
            const raw = fs.readFileSync(lockPath, 'utf8').trim();
            if (parseInt(raw, 10) === process.pid) fs.unlinkSync(lockPath);
        } catch { /* already gone */ }
    };
    const onExit = () => release();
    process.on('exit', onExit);
    process.on('SIGINT', () => { release(); process.exit(130); });
    process.on('SIGTERM', () => { release(); process.exit(143); });
    return release;
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
    const collectionId = context.resolveCollectionId(absPath);
    const collectionName = context.getCollectionName(absPath);
    const ref = context.resolveRefId(absPath);
    log(`collection: ${collectionName} ref=${ref.display} identity=${collectionId.identity}`);
    // Lock per (collection, ref) so two branches on the same machine can index in parallel.
    const refSafe = ref.refId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const lockPath = path.join(resolveStateDir(), `index-${collectionName}-${refSafe}.lock`);
    const release = acquireIndexLock(lockPath);
    if (release === null) {
        const holder = (() => {
            try { return parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10); }
            catch { return 0; }
        })();
        log(`index-lock: another indexer holds ${lockPath} (pid=${holder}) — skipping`);
        process.stdout.write(JSON.stringify({ skipped: true, reason: 'already_indexing', pid: holder }) + '\n');
        return 0;
    }

    // Throttle progress saves to at most once per 2s so the snapshot lock
    // isn't hammered when processFiles fires the callback per file.
    let lastSaveMs = 0;
    let lastPct = 0;
    const persistProgress = (pct: number, force = false) => {
        lastPct = pct;
        const now = Date.now();
        if (!force && now - lastSaveMs < 2000) return;
        lastSaveMs = now;
        try {
            snapshot.setCodebaseIndexing(absPath, pct);
            snapshot.saveCodebaseSnapshot();
        } catch (err) {
            log(`snapshot: progress save failed (${err instanceof Error ? err.message : String(err)})`);
        }
    };

    try {
        const isIndexed = snapshot.getIndexedCodebases().includes(absPath);
        const vectorHasIndex = await context.hasIndex(absPath);

        // Incremental path: snapshot says indexed and the collection still exists.
        if (isIndexed && vectorHasIndex && !args.force) {
            log(`reindexByChange ${absPath}`);
            persistProgress(0, true);
            const stats = await context.reindexByChange(absPath, (p) => {
                log(`${p.phase} (${p.percentage}%)`);
                persistProgress(p.percentage);
            });
            // Restore the indexed record with unchanged file/chunk counts from
            // the prior snapshot (reindexByChange returns deltas, not totals).
            const prior = snapshot.getCodebaseInfo(absPath);
            const priorFiles = prior && prior.status === 'indexed' ? prior.indexedFiles : 0;
            const priorChunks = prior && prior.status === 'indexed' ? prior.totalChunks : 0;
            if (priorFiles > 0 || priorChunks > 0) {
                snapshot.setCodebaseIndexed(absPath, {
                    indexedFiles: priorFiles,
                    totalChunks: priorChunks,
                    status: 'completed',
                });
                snapshot.saveCodebaseSnapshot();
            }
            process.stdout.write(JSON.stringify({ mode: 'incremental', ...stats }) + '\n');
            return 0;
        }

        // Full index path.
        log(`indexCodebase ${absPath}${args.force ? ' (force)' : ''}`);
        persistProgress(0, true);
        const stats = await context.indexCodebase(
            absPath,
            (p) => {
                log(`${p.phase} (${p.percentage}%)`);
                persistProgress(p.percentage);
            },
            args.force === true,
        );
        if (stats.indexedFiles > 0 || stats.totalChunks > 0) {
            snapshot.setCodebaseIndexed(absPath, stats);
            snapshot.saveCodebaseSnapshot();
        }
        process.stdout.write(JSON.stringify({ mode: 'full', ...stats }) + '\n');
        return 0;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
            snapshot.setCodebaseIndexFailed(absPath, msg, lastPct);
            snapshot.saveCodebaseSnapshot();
        } catch (saveErr) {
            log(`snapshot: failure record save failed (${saveErr instanceof Error ? saveErr.message : String(saveErr)})`);
        }
        throw err;
    } finally {
        release();
    }
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
    const collectionId = context.resolveCollectionId(absPath);
    const ref = context.resolveRefId(absPath);
    log(`search: ref=${ref.display} identity=${collectionId.identity}`);
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
    const { context, snapshot, vectorDatabase } = buildContext();
    const status = snapshot.getCodebaseStatus(absPath);
    const progress = snapshot.getIndexingProgress(absPath);
    const info = snapshot.getCodebaseInfo(absPath);

    const collectionId = context.resolveCollectionId(absPath);
    const collectionName = context.getCollectionName(absPath);
    const ref = context.resolveRefId(absPath);
    let collectionPresent = false;
    let collectionRowCount = -1;
    try {
        collectionRowCount = await vectorDatabase.getCollectionRowCount(collectionName);
        collectionPresent = collectionRowCount >= 0;
    } catch (err) {
        log(`status: row-count probe failed (${err instanceof Error ? err.message : String(err)})`);
    }

    process.stdout.write(
        JSON.stringify({
            path: absPath,
            status,
            progress,
            info,
            collectionName,
            collectionIdentity: collectionId.identity,
            refId: ref.refId,
            refDisplay: ref.display,
            collectionPresent,
            collectionRowCount,
        }) + '\n',
    );
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
