import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { MerkleDAG } from './merkle';

/**
 * Resolve the directory where merkle snapshots are stored.
 * Honors CLAUDE_CONTEXT_STATE_DIR (default: ~/.litellm/plugin-state/claude-context).
 */
function merkleDir(): string {
    const base = process.env.CLAUDE_CONTEXT_STATE_DIR
        || path.join(os.homedir(), '.litellm', 'plugin-state', 'claude-context');
    return path.join(base, 'merkle');
}

export class FileSynchronizer {
    private fileHashes: Map<string, string>;
    private merkleDAG: MerkleDAG;
    private rootDir: string;
    private snapshotPath: string;
    private ignorePatterns: string[];
    private supportedExtensions: string[];

    constructor(rootDir: string, ignorePatterns: string[] = [], supportedExtensions: string[] = []) {
        this.rootDir = rootDir;
        this.snapshotPath = this.getSnapshotPath(rootDir);
        this.fileHashes = new Map();
        this.merkleDAG = new MerkleDAG();
        this.ignorePatterns = ignorePatterns;
        this.supportedExtensions = supportedExtensions;
    }

    private getSnapshotPath(codebasePath: string): string {
        const normalizedPath = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
        return path.join(merkleDir(), `${hash}.json`);
    }

    private async hashFile(filePath: string): Promise<string> {
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) throw new Error(`Attempted to hash a directory: ${filePath}`);
        const content = await fs.readFile(filePath, 'utf-8');
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private async generateFileHashes(dir: string): Promise<Map<string, string>> {
        const fileHashes = new Map<string, string>();
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error: any) {
            console.warn(`[Synchronizer] Cannot read directory ${dir}: ${error.message}`);
            return fileHashes;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(this.rootDir, fullPath);
            if (this.shouldIgnore(relativePath, entry.isDirectory())) continue;

            let stat;
            try { stat = await fs.stat(fullPath); }
            catch (error: any) {
                console.warn(`[Synchronizer] Cannot stat ${fullPath}: ${error.message}`);
                continue;
            }

            if (stat.isDirectory()) {
                if (!this.shouldIgnore(relativePath, true)) {
                    const subHashes = await this.generateFileHashes(fullPath);
                    for (const [p, h] of subHashes.entries()) fileHashes.set(p, h);
                }
            } else if (stat.isFile()) {
                if (!this.shouldIgnore(relativePath, false)) {
                    const ext = path.extname(entry.name);
                    if (this.supportedExtensions.length > 0 && !this.supportedExtensions.includes(ext)) continue;
                    try {
                        const hash = await this.hashFile(fullPath);
                        fileHashes.set(relativePath, hash);
                    } catch (error: any) {
                        console.warn(`[Synchronizer] Cannot hash file ${fullPath}: ${error.message}`);
                    }
                }
            }
        }
        return fileHashes;
    }

    private shouldIgnore(relativePath: string, isDirectory: boolean = false): boolean {
        const pathParts = relativePath.split(path.sep);
        if (pathParts.some(part => part.startsWith('.'))) return true;
        if (this.ignorePatterns.length === 0) return false;
        const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!normalizedPath) return false;
        for (const pattern of this.ignorePatterns) {
            if (this.matchPattern(normalizedPath, pattern, isDirectory)) return true;
        }
        const normalizedPathParts = normalizedPath.split('/');
        for (let i = 0; i < normalizedPathParts.length; i++) {
            const partialPath = normalizedPathParts.slice(0, i + 1).join('/');
            for (const pattern of this.ignorePatterns) {
                if (pattern.endsWith('/')) {
                    const dirPattern = pattern.slice(0, -1);
                    if (this.simpleGlobMatch(partialPath, dirPattern) ||
                        this.simpleGlobMatch(normalizedPathParts[i], dirPattern)) return true;
                } else if (pattern.includes('/')) {
                    if (this.simpleGlobMatch(partialPath, pattern)) return true;
                } else {
                    if (this.simpleGlobMatch(normalizedPathParts[i], pattern)) return true;
                }
            }
        }
        return false;
    }

    private matchPattern(filePath: string, pattern: string, isDirectory: boolean = false): boolean {
        const cleanPath = filePath.replace(/^\/+|\/+$/g, '');
        const cleanPattern = pattern.replace(/^\/+|\/+$/g, '');
        if (!cleanPath || !cleanPattern) return false;
        if (pattern.endsWith('/')) {
            if (!isDirectory) return false;
            const dirPattern = cleanPattern.slice(0, -1);
            return this.simpleGlobMatch(cleanPath, dirPattern) ||
                cleanPath.split('/').some(part => this.simpleGlobMatch(part, dirPattern));
        }
        if (cleanPattern.includes('/')) return this.simpleGlobMatch(cleanPath, cleanPattern);
        const fileName = path.basename(cleanPath);
        return this.simpleGlobMatch(fileName, cleanPattern);
    }

    private simpleGlobMatch(text: string, pattern: string): boolean {
        if (!text || !pattern) return false;
        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        return new RegExp(`^${regexPattern}$`).test(text);
    }

    private buildMerkleDAG(fileHashes: Map<string, string>): MerkleDAG {
        const dag = new MerkleDAG();
        const keys = Array.from(fileHashes.keys());
        const sortedPaths = keys.slice().sort();
        let valuesString = "";
        keys.forEach(key => { valuesString += fileHashes.get(key); });
        const rootNodeId = dag.addNode("root:" + valuesString);
        for (const p of sortedPaths) dag.addNode(p + ":" + fileHashes.get(p), rootNodeId);
        return dag;
    }

    public async initialize() {
        console.log(`Initializing file synchronizer for ${this.rootDir}`);
        await this.loadSnapshot();
        this.merkleDAG = this.buildMerkleDAG(this.fileHashes);
        console.log(`[Synchronizer] Loaded ${this.fileHashes.size} file hashes.`);
    }

    public async checkForChanges(): Promise<{ added: string[], removed: string[], modified: string[] }> {
        const newFileHashes = await this.generateFileHashes(this.rootDir);
        const newMerkleDAG = this.buildMerkleDAG(newFileHashes);
        const changes = MerkleDAG.compare(this.merkleDAG, newMerkleDAG);
        if (changes.added.length > 0 || changes.removed.length > 0 || changes.modified.length > 0) {
            const fileChanges = this.compareStates(this.fileHashes, newFileHashes);
            this.fileHashes = newFileHashes;
            this.merkleDAG = newMerkleDAG;
            await this.saveSnapshot();
            return fileChanges;
        }
        return { added: [], removed: [], modified: [] };
    }

    private compareStates(oldHashes: Map<string, string>, newHashes: Map<string, string>): { added: string[], removed: string[], modified: string[] } {
        const added: string[] = [];
        const removed: string[] = [];
        const modified: string[] = [];
        for (const [file, hash] of newHashes.entries()) {
            if (!oldHashes.has(file)) added.push(file);
            else if (oldHashes.get(file) !== hash) modified.push(file);
        }
        for (const file of oldHashes.keys()) {
            if (!newHashes.has(file)) removed.push(file);
        }
        return { added, removed, modified };
    }

    public getFileHash(filePath: string): string | undefined {
        return this.fileHashes.get(filePath);
    }

    private async saveSnapshot(): Promise<void> {
        await fs.mkdir(path.dirname(this.snapshotPath), { recursive: true });
        const fileHashesArray: [string, string][] = Array.from(this.fileHashes.entries());
        const data = JSON.stringify({ fileHashes: fileHashesArray, merkleDAG: this.merkleDAG.serialize() });
        await fs.writeFile(this.snapshotPath, data, 'utf-8');
    }

    private async loadSnapshot(): Promise<void> {
        try {
            const data = await fs.readFile(this.snapshotPath, 'utf-8');
            const obj = JSON.parse(data);
            this.fileHashes = new Map();
            for (const [key, value] of obj.fileHashes) this.fileHashes.set(key, value);
            if (obj.merkleDAG) this.merkleDAG = MerkleDAG.deserialize(obj.merkleDAG);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                this.fileHashes = await this.generateFileHashes(this.rootDir);
                this.merkleDAG = this.buildMerkleDAG(this.fileHashes);
                await this.saveSnapshot();
            } else {
                throw error;
            }
        }
    }

    static async deleteSnapshot(codebasePath: string): Promise<void> {
        const normalizedPath = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
        const snapshotPath = path.join(merkleDir(), `${hash}.json`);
        try {
            await fs.unlink(snapshotPath);
        } catch (error: any) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
}
