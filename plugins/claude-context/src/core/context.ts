import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { Splitter, CodeChunk, LangChainCodeSplitter } from './splitter';
import { Embedding, EmbeddingVector } from './embedding/base-embedding';
import {
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
} from './vectordb/types';
import { GatewayVectorDatabase, RefOverlayEntry } from './vectordb/gateway-vectordb';
import { SemanticSearchResult } from './types';
import { envManager } from './utils/env-manager';
import { FileSynchronizer } from './sync/synchronizer';

export interface CollectionId {
    name: string;
    /** Human-readable identity used to derive the name (git URL or abs path). */
    identity: string;
}

export interface RefId {
    /** Wire value passed as ?ref=… e.g. `branch:main` or `user:ab12cd34`. */
    refId: string;
    /** Short display label for logs/status, e.g. `main` or `user-ab12cd34`. */
    display: string;
}

/**
 * Normalize a git remote URL so two clones with differently-shaped remotes
 * (ssh vs https, trailing `.git`, case-mixed host) produce the same key.
 *
 *   git@github.com:Foo/Bar.git → github.com/foo/bar
 *   https://github.com/foo/bar → github.com/foo/bar
 *   ssh://git@gitlab.com:22/a/b.git → gitlab.com/a/b
 */
function normalizeGitUrl(raw: string): string {
    let u = raw.trim();
    if (!u) return u;
    // Strip scheme
    u = u.replace(/^(?:git\+)?(?:ssh|https?|git):\/\//i, '');
    // git@host:path → host/path
    u = u.replace(/^[^@\s]+@([^:\s]+):/, '$1/');
    // drop user@ prefix if still present
    u = u.replace(/^[^@\s]+@/, '');
    // drop port specifiers like host:22/
    u = u.replace(/^([^/]+):\d+\//, '$1/');
    // trim trailing whitespace / slashes / .git
    u = u.replace(/\.git$/i, '').replace(/\/+$/, '');
    // lowercase the host portion only; keep path case so gitlab.com/Foo/Bar
    // is distinct from /foo/bar only if the provider is case-sensitive.
    const slash = u.indexOf('/');
    if (slash > 0) {
        u = u.slice(0, slash).toLowerCase() + u.slice(slash);
    } else {
        u = u.toLowerCase();
    }
    return u;
}

function readGitRemote(codebasePath: string): string | null {
    try {
        const res = spawnSync('git', ['-C', codebasePath, 'remote', 'get-url', 'origin'], {
            encoding: 'utf8',
            timeout: 1500,
        });
        if (res.status !== 0) return null;
        const out = (res.stdout || '').trim();
        return out || null;
    } catch {
        return null;
    }
}

function readGitBranch(codebasePath: string): string | null {
    try {
        const res = spawnSync('git', ['-C', codebasePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
            encoding: 'utf8',
            timeout: 1500,
        });
        if (res.status !== 0) return null;
        const out = (res.stdout || '').trim();
        if (!out || out === 'HEAD') return null; // detached HEAD
        return out;
    } catch {
        return null;
    }
}

/**
 * Resolve the ref_id for a codebase — the overlay key that distinguishes
 * one branch's view from another's. Falls back to a per-api-key sentinel
 * for detached HEADs / non-git repos so distinct users don't collide on
 * a shared "unknown" ref.
 */
export function resolveRefId(codebasePath: string, apiKeyForFallback = ''): RefId {
    const branch = readGitBranch(codebasePath);
    if (branch) return { refId: `branch:${branch}`, display: branch };
    // TODO: also consider process.env.LITELLMCTL_API_KEY when renaming env vars.
    const fallbackSource = apiKeyForFallback || process.env.LLM_GATEWAY_API_KEY || 'anonymous';
    const hash = crypto.createHash('sha256').update(fallbackSource).digest('hex').slice(0, 12);
    return { refId: `user:${hash}`, display: `user-${hash}` };
}

const DEFAULT_SUPPORTED_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.scala', '.m', '.mm',
    '.md', '.markdown', '.ipynb',
];

const DEFAULT_IGNORE_PATTERNS = [
    'node_modules/**', 'dist/**', 'build/**', 'out/**', 'target/**',
    'coverage/**', '.nyc_output/**',
    '.vscode/**', '.idea/**', '*.swp', '*.swo',
    '.git/**', '.svn/**', '.hg/**',
    '.cache/**', '__pycache__/**', '.pytest_cache/**',
    'logs/**', 'tmp/**', 'temp/**', '*.log',
    '.env', '.env.*', '*.local',
    '*.min.js', '*.min.css', '*.min.map',
    '*.bundle.js', '*.bundle.css', '*.chunk.js',
    '*.vendor.js', '*.polyfills.js', '*.runtime.js', '*.map',
    'node_modules', '.git', '.svn', '.hg', 'build', 'dist', 'out',
    'target', '.vscode', '.idea', '__pycache__', '.pytest_cache',
    'coverage', '.nyc_output', 'logs', 'tmp', 'temp',
];

export interface ContextConfig {
    embedding: Embedding;
    vectorDatabase: VectorDatabase;
    codeSplitter?: Splitter;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[];
    customIgnorePatterns?: string[];
}

export class Context {
    private embedding: Embedding;
    private vectorDatabase: VectorDatabase;
    private codeSplitter: Splitter;
    private supportedExtensions: string[];
    private ignorePatterns: string[];
    private synchronizers = new Map<string, FileSynchronizer>();

    constructor(config: ContextConfig) {
        if (!config.embedding) {
            throw new Error('Embedding is required. Provide a LiteLLMEmbedding instance.');
        }
        if (!config.vectorDatabase) {
            throw new Error('VectorDatabase is required. Provide a GatewayVectorDatabase instance.');
        }
        this.embedding = config.embedding;
        this.vectorDatabase = config.vectorDatabase;
        this.codeSplitter = config.codeSplitter || new LangChainCodeSplitter(1000, 200);

        const envCustomExtensions = this.getCustomExtensionsFromEnv();
        this.supportedExtensions = [...new Set([
            ...DEFAULT_SUPPORTED_EXTENSIONS,
            ...(config.supportedExtensions || []),
            ...(config.customExtensions || []),
            ...envCustomExtensions,
        ])];

        const envCustomIgnorePatterns = this.getCustomIgnorePatternsFromEnv();
        this.ignorePatterns = [...new Set([
            ...DEFAULT_IGNORE_PATTERNS,
            ...(config.ignorePatterns || []),
            ...(config.customIgnorePatterns || []),
            ...envCustomIgnorePatterns,
        ])];

        console.log(`[Context] Initialized with ${this.supportedExtensions.length} extensions, ${this.ignorePatterns.length} ignore patterns`);
    }

    getEmbedding(): Embedding { return this.embedding; }
    getVectorDatabase(): VectorDatabase { return this.vectorDatabase; }
    getCodeSplitter(): Splitter { return this.codeSplitter; }
    getSupportedExtensions(): string[] { return [...this.supportedExtensions]; }
    getIgnorePatterns(): string[] { return [...this.ignorePatterns]; }
    getSynchronizers(): Map<string, FileSynchronizer> { return new Map(this.synchronizers); }

    setSynchronizer(collectionName: string, synchronizer: FileSynchronizer): void {
        this.synchronizers.set(collectionName, synchronizer);
    }

    async getLoadedIgnorePatterns(codebasePath: string): Promise<void> {
        return this.loadIgnorePatterns(codebasePath);
    }

    async getPreparedCollection(codebasePath: string): Promise<void> {
        return this.prepareCollection(codebasePath);
    }

    /**
     * Resolve the collection id for a codebase. The gateway hosts one global
     * shared pool; collection identity is derived from the normalized git
     * origin URL when available (so two clones of the same repo see the same
     * vectors) and falls back to the absolute path otherwise.
     */
    public resolveCollectionId(codebasePath: string): CollectionId {
        const absPath = path.resolve(codebasePath);
        const remote = readGitRemote(absPath);
        if (remote) {
            const identity = normalizeGitUrl(remote);
            if (identity) {
                const hash = crypto.createHash('md5').update(identity).digest('hex');
                return { name: `code_shared_${hash.substring(0, 8)}`, identity };
            }
        }
        const hash = crypto.createHash('md5').update(absPath).digest('hex');
        return { name: `code_shared_${hash.substring(0, 8)}`, identity: absPath };
    }

    public getCollectionName(codebasePath: string): string {
        return this.resolveCollectionId(codebasePath).name;
    }

    public resolveRefId(codebasePath: string): RefId {
        return resolveRefId(codebasePath);
    }

    /**
     * Chunk the working tree, upload only chunks the gateway doesn't already
     * have, then replace this ref's overlay with the fresh file → chunk_ids
     * map. Idempotent: calling this twice in a row without local changes
     * re-uploads nothing (all chunk_ids hit the existing-chunks probe) and
     * just re-writes the same overlay.
     */
    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        forceReindex: boolean = false,
    ): Promise<{
        indexedFiles: number;
        totalChunks: number;
        uploadedChunks: number;
        existingChunks: number;
        status: 'completed' | 'limit_reached';
    }> {
        console.log(`[Context] Indexing codebase: ${codebasePath}`);
        await this.loadIgnorePatterns(codebasePath);

        progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
        await this.prepareCollection(codebasePath, forceReindex);
        const collectionName = this.getCollectionName(codebasePath);
        const { refId } = this.resolveRefId(codebasePath);

        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const codeFiles = await this.getCodeFiles(codebasePath);
        console.log(`[Context] Found ${codeFiles.length} code files (ref=${refId})`);

        const gateway = this.vectorDatabase as GatewayVectorDatabase;
        if (codeFiles.length === 0) {
            // Empty tree on this ref → empty overlay (gateway deletes stale rows).
            if (typeof gateway.setRefOverlay === 'function') {
                await gateway.setRefOverlay(collectionName, refId, []);
            }
            progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
            return { indexedFiles: 0, totalChunks: 0, uploadedChunks: 0, existingChunks: 0, status: 'completed' };
        }

        // Phase 1 — chunk every file, build the full overlay and an embed queue.
        const CHUNK_LIMIT = 450000;
        const chunkPhaseStart = 10;
        const chunkPhaseEnd = 50;
        const chunkRange = chunkPhaseEnd - chunkPhaseStart;

        interface PendingChunk {
            chunk: CodeChunk;
            chunkId: string;
            relativePath: string;
        }
        const overlayEntries: RefOverlayEntry[] = [];
        const pendingByChunkId = new Map<string, PendingChunk>();
        let processedFiles = 0;
        let limitReached = false;

        for (let i = 0; i < codeFiles.length; i++) {
            const filePath = codeFiles[i];
            try {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const language = this.getLanguageFromExtension(path.extname(filePath));
                const chunks = await this.codeSplitter.split(content, language, filePath);
                const relativePath = path.relative(codebasePath, filePath);
                const chunkIds: string[] = [];
                for (const chunk of chunks) {
                    const chunkId = this.generateId(
                        relativePath,
                        chunk.metadata.startLine || 0,
                        chunk.metadata.endLine || 0,
                        chunk.content,
                    );
                    chunkIds.push(chunkId);
                    if (!pendingByChunkId.has(chunkId)) {
                        pendingByChunkId.set(chunkId, { chunk, chunkId, relativePath });
                        if (pendingByChunkId.size >= CHUNK_LIMIT) {
                            limitReached = true;
                            break;
                        }
                    }
                }
                overlayEntries.push({ filePath: relativePath, chunkIds });
                processedFiles++;
            } catch (err) {
                console.warn(`[Context] Skipping file ${filePath}: ${err}`);
                continue;
            }
            const pct = chunkPhaseStart + ((i + 1) / codeFiles.length) * chunkRange;
            progressCallback?.({
                phase: `Chunking files (${i + 1}/${codeFiles.length})...`,
                current: i + 1,
                total: codeFiles.length,
                percentage: Math.round(pct),
            });
            if (limitReached) break;
        }

        const allChunkIds = [...pendingByChunkId.keys()];

        // Phase 2 — ask the gateway which chunks it already has.
        progressCallback?.({ phase: 'Checking existing chunks...', current: 0, total: 100, percentage: 55 });
        const existing =
            typeof gateway.listExistingChunkIds === 'function'
                ? await gateway.listExistingChunkIds(collectionName, allChunkIds)
                : new Set<string>();
        const missingIds = allChunkIds.filter((id) => !existing.has(id));
        console.log(
            `[Context] chunks: ${allChunkIds.length} total, ${existing.size} already stored, ${missingIds.length} to embed`,
        );

        // Phase 3 — embed + insert only the missing chunks, in batches.
        const embedPhaseStart = 55;
        const embedPhaseEnd = 95;
        const embedRange = embedPhaseEnd - embedPhaseStart;
        const BATCH = Math.max(1, parseInt(envManager.get('EMBEDDING_BATCH_SIZE') || '64', 10));
        let uploaded = 0;
        for (let i = 0; i < missingIds.length; i += BATCH) {
            const slice = missingIds.slice(i, i + BATCH);
            try {
                await this.embedAndInsertChunks(collectionName, codebasePath, slice, pendingByChunkId);
            } catch (err) {
                console.error('[Context] Failed to embed/insert batch:', err);
            }
            uploaded += slice.length;
            const pct =
                missingIds.length === 0
                    ? embedPhaseEnd
                    : embedPhaseStart + (uploaded / missingIds.length) * embedRange;
            progressCallback?.({
                phase: `Embedding chunks (${uploaded}/${missingIds.length})...`,
                current: uploaded,
                total: missingIds.length,
                percentage: Math.round(pct),
            });
        }

        // Phase 4 — replace the ref overlay so the new file → chunks map is live.
        progressCallback?.({ phase: 'Updating ref overlay...', current: 0, total: 100, percentage: 97 });
        if (typeof gateway.setRefOverlay === 'function') {
            await gateway.setRefOverlay(collectionName, refId, overlayEntries);
        }
        progressCallback?.({
            phase: 'Indexing complete',
            current: processedFiles,
            total: codeFiles.length,
            percentage: 100,
        });

        return {
            indexedFiles: processedFiles,
            totalChunks: allChunkIds.length,
            uploadedChunks: uploaded,
            existingChunks: existing.size,
            status: limitReached ? 'limit_reached' : 'completed',
        };
    }

    /**
     * Report file-level changes since the synchronizer's last known state.
     * Still calls indexCodebase (which rebuilds the entire overlay for this
     * ref) — the overlay model makes partial reindex equivalent to a full
     * reindex, so we just surface the file-delta counts for logging.
     */
    async reindexByChange(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
    ): Promise<{ added: number; removed: number; modified: number }> {
        const collectionName = this.getCollectionName(codebasePath);
        if (!this.synchronizers.has(collectionName)) {
            await this.loadIgnorePatterns(codebasePath);
            const newSync = new FileSynchronizer(codebasePath, this.ignorePatterns, this.supportedExtensions);
            await newSync.initialize();
            this.synchronizers.set(collectionName, newSync);
        }
        const sync = this.synchronizers.get(collectionName)!;
        const { added, removed, modified } = await sync.checkForChanges();

        if (added.length + removed.length + modified.length === 0) {
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            return { added: 0, removed: 0, modified: 0 };
        }

        await this.indexCodebase(codebasePath, progressCallback, false);
        return { added: added.length, removed: removed.length, modified: modified.length };
    }

    /**
     * Embed `chunkIds` (slice of the overall batch) and insert with those
     * exact IDs so the gateway's dedupe matches what listExistingChunkIds
     * reported.
     */
    private async embedAndInsertChunks(
        collectionName: string,
        codebasePath: string,
        chunkIds: string[],
        pendingByChunkId: Map<string, { chunk: CodeChunk; chunkId: string; relativePath: string }>,
    ): Promise<void> {
        if (chunkIds.length === 0) return;
        const pending = chunkIds.map((id) => pendingByChunkId.get(id)!).filter(Boolean);
        const contents = pending.map((p) => p.chunk.content);
        const embeddings = await this.embedding.embedBatch(contents);

        const documents: VectorDocument[] = pending.map((p, index) => {
            const { chunk, chunkId, relativePath } = p;
            const fileExtension = path.extname(chunk.metadata.filePath || '');
            const { filePath: _omit, startLine, endLine, ...restMetadata } = chunk.metadata;
            return {
                id: chunkId,
                vector: embeddings[index].vector,
                content: chunk.content,
                relativePath,
                startLine: chunk.metadata.startLine || 0,
                endLine: chunk.metadata.endLine || 0,
                fileExtension,
                metadata: {
                    ...restMetadata,
                    codebasePath,
                    language: chunk.metadata.language || 'unknown',
                },
            };
        });
        await this.vectorDatabase.insert(collectionName, documents);
    }

    async semanticSearch(
        codebasePath: string,
        query: string,
        topK: number = 5,
        threshold: number = 0.5,
        filterExpr?: string,
    ): Promise<SemanticSearchResult[]> {
        const collectionName = this.getCollectionName(codebasePath);
        const { refId } = this.resolveRefId(codebasePath);
        console.log(`[Context] Searching "${query}" in ${codebasePath} (ref=${refId})`);
        if (!(await this.vectorDatabase.hasCollection(collectionName))) {
            console.log(`[Context] Collection '${collectionName}' not found. Index the codebase first.`);
            return [];
        }

        const queryEmbedding: EmbeddingVector = await this.embedding.embed(query);
        const searchResults: VectorSearchResult[] = await this.vectorDatabase.search(
            collectionName,
            queryEmbedding.vector,
            { topK, threshold, filterExpr, refId },
        );

        return searchResults.map((r) => ({
            content: r.document.content,
            relativePath: r.document.relativePath,
            startLine: r.document.startLine,
            endLine: r.document.endLine,
            language: r.document.metadata.language || 'unknown',
            score: r.score,
        }));
    }

    async hasIndex(codebasePath: string): Promise<boolean> {
        return this.vectorDatabase.hasCollection(this.getCollectionName(codebasePath));
    }

    async clearIndex(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
    ): Promise<void> {
        progressCallback?.({ phase: 'Checking existing index...', current: 0, total: 100, percentage: 0 });
        const collectionName = this.getCollectionName(codebasePath);
        if (await this.vectorDatabase.hasCollection(collectionName)) {
            await this.vectorDatabase.dropCollection(collectionName);
        }
        await FileSynchronizer.deleteSnapshot(codebasePath);
        progressCallback?.({ phase: 'Index cleared', current: 100, total: 100, percentage: 100 });
    }

    updateIgnorePatterns(ignorePatterns: string[]): void {
        this.ignorePatterns = [...new Set([...DEFAULT_IGNORE_PATTERNS, ...ignorePatterns])];
    }

    addCustomIgnorePatterns(customPatterns: string[]): void {
        if (!customPatterns.length) return;
        this.ignorePatterns = [...new Set([...this.ignorePatterns, ...customPatterns])];
    }

    resetIgnorePatternsToDefaults(): void {
        this.ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
    }

    updateEmbedding(embedding: Embedding): void {
        this.embedding = embedding;
    }

    updateVectorDatabase(vectorDatabase: VectorDatabase): void {
        this.vectorDatabase = vectorDatabase;
    }

    updateSplitter(splitter: Splitter): void {
        this.codeSplitter = splitter;
    }

    private async prepareCollection(codebasePath: string, forceReindex: boolean = false): Promise<void> {
        const collectionName = this.getCollectionName(codebasePath);
        const exists = await this.vectorDatabase.hasCollection(collectionName);
        if (exists && !forceReindex) return;
        if (exists && forceReindex) {
            await this.vectorDatabase.dropCollection(collectionName);
        }
        const dimension = await this.embedding.detectDimension();
        await this.vectorDatabase.createCollection(collectionName, dimension, `codebasePath:${codebasePath}`);
        console.log(`[Context] Collection ${collectionName} created (dim=${dimension})`);
    }

    private async getCodeFiles(codebasePath: string): Promise<string[]> {
        const files: string[] = [];
        const traverse = async (currentPath: string) => {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                if (this.matchesIgnorePattern(fullPath, codebasePath)) continue;
                if (entry.isDirectory()) await traverse(fullPath);
                else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (this.supportedExtensions.includes(ext)) files.push(fullPath);
                }
            }
        };
        await traverse(codebasePath);
        return files;
    }

    private getLanguageFromExtension(ext: string): string {
        const map: Record<string, string> = {
            '.ts': 'typescript', '.tsx': 'typescript',
            '.js': 'javascript', '.jsx': 'javascript',
            '.py': 'python', '.java': 'java',
            '.cpp': 'cpp', '.c': 'c', '.h': 'c', '.hpp': 'cpp',
            '.cs': 'csharp', '.go': 'go', '.rs': 'rust',
            '.php': 'php', '.rb': 'ruby', '.swift': 'swift',
            '.kt': 'kotlin', '.scala': 'scala',
            '.m': 'objective-c', '.mm': 'objective-c',
            '.ipynb': 'jupyter', '.md': 'markdown', '.markdown': 'markdown',
        };
        return map[ext] || 'text';
    }

    private generateId(relativePath: string, startLine: number, endLine: number, content: string): string {
        const combined = `${relativePath}:${startLine}:${endLine}:${content}`;
        const hash = crypto.createHash('sha256').update(combined, 'utf-8').digest('hex');
        return `chunk_${hash.substring(0, 16)}`;
    }

    static async getIgnorePatternsFromFile(filePath: string): Promise<string[]> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
        } catch {
            return [];
        }
    }

    private async loadIgnorePatterns(codebasePath: string): Promise<void> {
        try {
            const fileBased: string[] = [];
            const ignoreFiles = await this.findIgnoreFiles(codebasePath);
            for (const f of ignoreFiles) {
                fileBased.push(...(await Context.getIgnorePatternsFromFile(f)));
            }
            if (fileBased.length > 0) this.addCustomIgnorePatterns(fileBased);
        } catch (error) {
            console.warn(`[Context] Failed to load ignore patterns: ${error}`);
        }
    }

    private async findIgnoreFiles(codebasePath: string): Promise<string[]> {
        try {
            const entries = await fs.promises.readdir(codebasePath, { withFileTypes: true });
            return entries
                .filter((e) => e.isFile() && e.name.startsWith('.') && e.name.endsWith('ignore'))
                .map((e) => path.join(codebasePath, e.name));
        } catch {
            return [];
        }
    }

    private matchesIgnorePattern(filePath: string, basePath: string): boolean {
        if (!this.ignorePatterns.length) return false;
        const rel = path.relative(basePath, filePath).replace(/\\/g, '/');
        for (const pattern of this.ignorePatterns) {
            if (this.isPatternMatch(rel, pattern)) return true;
        }
        return false;
    }

    private isPatternMatch(filePath: string, pattern: string): boolean {
        if (pattern.endsWith('/')) {
            const dir = pattern.slice(0, -1);
            return filePath.split('/').some((part) => this.simpleGlobMatch(part, dir));
        }
        if (pattern.includes('/')) return this.simpleGlobMatch(filePath, pattern);
        const fileName = path.basename(filePath);
        return this.simpleGlobMatch(fileName, pattern);
    }

    private simpleGlobMatch(text: string, pattern: string): boolean {
        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        return new RegExp(`^${regexPattern}$`).test(text);
    }

    private getCustomExtensionsFromEnv(): string[] {
        const env = envManager.get('CUSTOM_EXTENSIONS');
        if (!env) return [];
        return env.split(',').map((s) => s.trim()).filter(Boolean).map((e) => (e.startsWith('.') ? e : `.${e}`));
    }

    private getCustomIgnorePatternsFromEnv(): string[] {
        const env = envManager.get('CUSTOM_IGNORE_PATTERNS');
        if (!env) return [];
        return env.split(',').map((s) => s.trim()).filter(Boolean);
    }

    addCustomExtensions(customExtensions: string[]): void {
        if (!customExtensions.length) return;
        const normalized = customExtensions.map((e) => (e.startsWith('.') ? e : `.${e}`));
        this.supportedExtensions = [...new Set([...this.supportedExtensions, ...normalized])];
    }

    getSplitterInfo(): { type: string; hasBuiltinFallback: boolean } {
        return { type: 'langchain', hasBuiltinFallback: false };
    }

    isLanguageSupported(_language: string): boolean {
        return true;
    }

    getSplitterStrategyForLanguage(_language: string): { strategy: 'langchain'; reason: string } {
        return { strategy: 'langchain', reason: 'Using LangChain splitter' };
    }
}
