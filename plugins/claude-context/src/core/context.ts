import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Splitter, CodeChunk, LangChainCodeSplitter } from './splitter';
import { Embedding, EmbeddingVector } from './embedding/base-embedding';
import {
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
} from './vectordb/types';
import { SemanticSearchResult } from './types';
import { envManager } from './utils/env-manager';
import { FileSynchronizer } from './sync/synchronizer';

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
     * Collection name — dense-only, tenant scoping comes from the gateway
     * via api_key_hash, so we can use the plain `code_chunks_<md5-8>` form.
     */
    public getCollectionName(codebasePath: string): string {
        const normalizedPath = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
        return `code_chunks_${hash.substring(0, 8)}`;
    }

    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        forceReindex: boolean = false,
    ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        console.log(`[Context] Indexing codebase: ${codebasePath}`);
        await this.loadIgnorePatterns(codebasePath);

        progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
        await this.prepareCollection(codebasePath, forceReindex);

        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const codeFiles = await this.getCodeFiles(codebasePath);
        console.log(`[Context] Found ${codeFiles.length} code files`);

        if (codeFiles.length === 0) {
            progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
            return { indexedFiles: 0, totalChunks: 0, status: 'completed' };
        }

        const indexingStart = 10;
        const indexingEnd = 100;
        const range = indexingEnd - indexingStart;

        const result = await this.processFileList(
            codeFiles,
            codebasePath,
            (_filePath, fileIndex, totalFiles) => {
                const pct = indexingStart + (fileIndex / totalFiles) * range;
                progressCallback?.({
                    phase: `Processing files (${fileIndex}/${totalFiles})...`,
                    current: fileIndex,
                    total: totalFiles,
                    percentage: Math.round(pct),
                });
            },
        );

        progressCallback?.({
            phase: 'Indexing complete',
            current: result.processedFiles,
            total: codeFiles.length,
            percentage: 100,
        });

        return {
            indexedFiles: result.processedFiles,
            totalChunks: result.totalChunks,
            status: result.status,
        };
    }

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
        progressCallback?.({ phase: 'Checking for file changes...', current: 0, total: 100, percentage: 0 });
        const { added, removed, modified } = await sync.checkForChanges();
        const totalChanges = added.length + removed.length + modified.length;

        if (totalChanges === 0) {
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            return { added: 0, removed: 0, modified: 0 };
        }

        let processed = 0;
        const update = (phase: string) => {
            processed++;
            const pct = Math.round((processed / totalChanges) * 100);
            progressCallback?.({ phase, current: processed, total: totalChanges, percentage: pct });
        };

        for (const file of removed) {
            await this.deleteFileChunks(collectionName, file);
            update(`Removed ${file}`);
        }
        for (const file of modified) {
            await this.deleteFileChunks(collectionName, file);
            update(`Deleted old chunks for ${file}`);
        }

        const filesToIndex = [...added, ...modified].map((f) => path.join(codebasePath, f));
        if (filesToIndex.length > 0) {
            await this.processFileList(
                filesToIndex,
                codebasePath,
                (filePath, fileIndex, totalFiles) => update(`Indexed ${filePath} (${fileIndex}/${totalFiles})`),
            );
        }

        progressCallback?.({ phase: 'Re-indexing complete', current: totalChanges, total: totalChanges, percentage: 100 });
        return { added: added.length, removed: removed.length, modified: modified.length };
    }

    private async deleteFileChunks(collectionName: string, relativePath: string): Promise<void> {
        // Gateway query parser accepts `<field> in [...]` only.
        const escaped = relativePath.replace(/"/g, '\\"');
        const results = await this.vectorDatabase.query(
            collectionName,
            `relativePath in ["${escaped}"]`,
            ['id'],
        );
        if (results.length > 0) {
            const ids = results.map((r) => r.id as string).filter(Boolean);
            if (ids.length > 0) {
                await this.vectorDatabase.delete(collectionName, ids);
                console.log(`[Context] Deleted ${ids.length} chunks for file ${relativePath}`);
            }
        }
    }

    async semanticSearch(
        codebasePath: string,
        query: string,
        topK: number = 5,
        threshold: number = 0.5,
        filterExpr?: string,
    ): Promise<SemanticSearchResult[]> {
        console.log(`[Context] Searching "${query}" in ${codebasePath}`);
        const collectionName = this.getCollectionName(codebasePath);
        if (!(await this.vectorDatabase.hasCollection(collectionName))) {
            console.log(`[Context] Collection '${collectionName}' not found. Index the codebase first.`);
            return [];
        }

        const queryEmbedding: EmbeddingVector = await this.embedding.embed(query);
        const searchResults: VectorSearchResult[] = await this.vectorDatabase.search(
            collectionName,
            queryEmbedding.vector,
            { topK, threshold, filterExpr },
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

    private async processFileList(
        filePaths: string[],
        codebasePath: string,
        onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void,
    ): Promise<{ processedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const BATCH = Math.max(1, parseInt(envManager.get('EMBEDDING_BATCH_SIZE') || '64', 10));
        const CHUNK_LIMIT = 450000;

        let chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }> = [];
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;

        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];
            try {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const language = this.getLanguageFromExtension(path.extname(filePath));
                const chunks = await this.codeSplitter.split(content, language, filePath);
                for (const chunk of chunks) {
                    chunkBuffer.push({ chunk, codebasePath });
                    totalChunks++;
                    if (chunkBuffer.length >= BATCH) {
                        try {
                            await this.processChunkBuffer(chunkBuffer);
                        } catch (error) {
                            console.error('[Context] Failed to process chunk batch:', error);
                        } finally {
                            chunkBuffer = [];
                        }
                    }
                    if (totalChunks >= CHUNK_LIMIT) {
                        limitReached = true;
                        break;
                    }
                }
                processedFiles++;
                onFileProcessed?.(filePath, i + 1, filePaths.length);
                if (limitReached) break;
            } catch (error) {
                console.warn(`[Context] Skipping file ${filePath}: ${error}`);
            }
        }

        if (chunkBuffer.length > 0) {
            try {
                await this.processChunkBuffer(chunkBuffer);
            } catch (error) {
                console.error('[Context] Failed to process final chunk batch:', error);
            }
        }

        return { processedFiles, totalChunks, status: limitReached ? 'limit_reached' : 'completed' };
    }

    private async processChunkBuffer(chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }>): Promise<void> {
        if (!chunkBuffer.length) return;
        const chunks = chunkBuffer.map((c) => c.chunk);
        const codebasePath = chunkBuffer[0].codebasePath;
        await this.processChunkBatch(chunks, codebasePath);
    }

    private async processChunkBatch(chunks: CodeChunk[], codebasePath: string): Promise<void> {
        const contents = chunks.map((c) => c.content);
        const embeddings = await this.embedding.embedBatch(contents);

        const documents: VectorDocument[] = chunks.map((chunk, index) => {
            if (!chunk.metadata.filePath) {
                throw new Error(`Missing filePath in chunk metadata at index ${index}`);
            }
            const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
            const fileExtension = path.extname(chunk.metadata.filePath);
            const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;
            return {
                id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
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
                    chunkIndex: index,
                },
            };
        });
        await this.vectorDatabase.insert(this.getCollectionName(codebasePath), documents);
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
