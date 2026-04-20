import {
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
    SearchOptions,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult,
} from './types';

export interface GatewayVectorDatabaseConfig {
    baseUrl: string;
    apiKey: string;
}

/**
 * VectorDatabase implementation that proxies all operations to the LiteLLM
 * gateway's /api/vectordb/* REST surface. State is persisted in the gateway's
 * sqlite-vec DB, scoped by api_key_hash (derived from apiKey).
 *
 * Hybrid-mode methods throw — this plugin runs dense-only.
 */
export class GatewayVectorDatabase implements VectorDatabase {
    private baseUrl: string;
    private apiKey: string;

    constructor(config: GatewayVectorDatabaseConfig) {
        if (!config.baseUrl) throw new Error('GatewayVectorDatabase: baseUrl required');
        if (!config.apiKey) throw new Error('GatewayVectorDatabase: apiKey required');
        this.baseUrl = config.baseUrl.replace(/\/$/, '');
        this.apiKey = config.apiKey;
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`[GatewayVectorDB] ${method} ${path} → ${res.status}: ${text}`);
        }
        if (res.status === 204) return undefined as unknown as T;
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('json')) return undefined as unknown as T;
        return (await res.json()) as T;
    }

    async createCollection(collectionName: string, dimension: number, _description?: string): Promise<void> {
        await this.request<{ created: boolean }>('POST', '/api/vectordb/collections', {
            name: collectionName,
            dimension,
        });
    }

    async createHybridCollection(_collectionName: string, _dimension: number, _description?: string): Promise<void> {
        throw new Error('Hybrid search not supported by this plugin (HYBRID_MODE=false).');
    }

    async dropCollection(collectionName: string): Promise<void> {
        await this.request<void>('DELETE', `/api/vectordb/collections/${encodeURIComponent(collectionName)}`);
    }

    async hasCollection(collectionName: string): Promise<boolean> {
        try {
            const info = await this.request<{ exists: boolean }>(
                'GET',
                `/api/vectordb/collections/${encodeURIComponent(collectionName)}`,
            );
            return !!info?.exists;
        } catch {
            return false;
        }
    }

    async listCollections(): Promise<string[]> {
        const res = await this.request<{ names: string[] }>('GET', '/api/vectordb/collections');
        return res?.names ?? [];
    }

    async insert(collectionName: string, documents: VectorDocument[]): Promise<void> {
        if (!documents.length) return;
        // Chunk to avoid oversized requests
        const BATCH = 128;
        for (let i = 0; i < documents.length; i += BATCH) {
            const slice = documents.slice(i, i + BATCH);
            await this.request<{ inserted: number }>(
                'POST',
                `/api/vectordb/collections/${encodeURIComponent(collectionName)}/insert`,
                { documents: slice },
            );
        }
    }

    async insertHybrid(_collectionName: string, _documents: VectorDocument[]): Promise<void> {
        throw new Error('Hybrid search not supported by this plugin (HYBRID_MODE=false).');
    }

    async search(
        collectionName: string,
        queryVector: number[],
        options?: SearchOptions,
    ): Promise<VectorSearchResult[]> {
        const res = await this.request<{ results: VectorSearchResult[] }>(
            'POST',
            `/api/vectordb/collections/${encodeURIComponent(collectionName)}/search`,
            {
                queryVector,
                topK: options?.topK ?? 10,
                filterExpr: options?.filterExpr ?? null,
            },
        );
        return res?.results ?? [];
    }

    async hybridSearch(
        _collectionName: string,
        _searchRequests: HybridSearchRequest[],
        _options?: HybridSearchOptions,
    ): Promise<HybridSearchResult[]> {
        throw new Error('Hybrid search not supported by this plugin (HYBRID_MODE=false).');
    }

    async delete(collectionName: string, ids: string[]): Promise<void> {
        if (!ids.length) return;
        await this.request<{ deleted: number }>(
            'POST',
            `/api/vectordb/collections/${encodeURIComponent(collectionName)}/delete`,
            { ids },
        );
    }

    async query(
        collectionName: string,
        filter: string,
        outputFields: string[],
        limit?: number,
    ): Promise<Record<string, any>[]> {
        const res = await this.request<{ rows: Record<string, any>[] }>(
            'POST',
            `/api/vectordb/collections/${encodeURIComponent(collectionName)}/query`,
            {
                filterExpr: filter,
                outputFields,
                limit: limit ?? 1000,
            },
        );
        return res?.rows ?? [];
    }

    async getCollectionDescription(_collectionName: string): Promise<string> {
        return '';
    }

    async checkCollectionLimit(): Promise<boolean> {
        return true;
    }

    async getCollectionRowCount(collectionName: string): Promise<number> {
        try {
            const info = await this.request<{ exists: boolean; rowCount: number }>(
                'GET',
                `/api/vectordb/collections/${encodeURIComponent(collectionName)}`,
            );
            if (!info?.exists) return -1;
            return info.rowCount;
        } catch {
            return -1;
        }
    }
}
