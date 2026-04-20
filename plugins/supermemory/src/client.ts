/**
 * Thin client that wraps the gateway's /v1/embeddings + /api/vectordb/*
 * to provide memory save / forget / recall backed by sqlite-vec.
 *
 * The gateway scopes all rows by api_key_hash, so this client is fully
 * per-tenant — no container tag / project plumbing needed for v1.
 */

import * as crypto from "node:crypto";
import {
    COLLECTION_NAME,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    type PluginConfig,
} from "./config";

// ── Wire types ────────────────────────────────────────────────────────────

interface OpenAIEmbeddingResponse {
    data: Array<{ embedding: number[]; index: number; object: string }>;
}

interface VectorDocument {
    id: string;
    vector: number[];
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    fileExtension: string;
    metadata: Record<string, unknown>;
}

interface VectorSearchResult {
    document: VectorDocument;
    score: number;
}

// ── Domain types ──────────────────────────────────────────────────────────

export interface Memory {
    id: string;
    memory: string;
    similarity: number;
    createdAt?: string;
}

export interface SearchResult {
    results: Memory[];
    total: number;
    timing: number;
}

// ── Client ────────────────────────────────────────────────────────────────

export class MemoryClient {
    private baseUrl: string;
    private apiKey: string;
    private collectionReady: Promise<void> | null = null;

    constructor(config: PluginConfig) {
        this.baseUrl = config.gatewayUrl.replace(/\/$/, "");
        this.apiKey = config.gatewayApiKey;
    }

    // ── Low-level HTTP helpers ────────────────────────────────────────────

    private async request<T>(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<T> {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.apiKey}`,
        };
        if (body !== undefined) headers["Content-Type"] = "application/json";

        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${method} ${path} → ${res.status}: ${text}`);
        }
        if (res.status === 204) return undefined as unknown as T;
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("json")) return undefined as unknown as T;
        return (await res.json()) as T;
    }

    private async embed(text: string): Promise<number[]> {
        const payload = {
            model: EMBEDDING_MODEL,
            input: text,
            dimensions: EMBEDDING_DIMENSIONS,
        };
        const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`embed failed: ${res.status} ${text}`);
        }
        const data = (await res.json()) as OpenAIEmbeddingResponse;
        const vec = data?.data?.[0]?.embedding;
        if (!Array.isArray(vec) || vec.length === 0) {
            throw new Error("embedding response missing data[0].embedding");
        }
        return vec;
    }

    // ── Collection bootstrap (idempotent) ─────────────────────────────────

    private async ensureCollection(): Promise<void> {
        if (this.collectionReady) return this.collectionReady;
        this.collectionReady = (async () => {
            // createCollection is idempotent — existing-with-same-dim returns 200.
            try {
                await this.request<{ created: boolean }>(
                    "POST",
                    "/api/vectordb/collections",
                    { name: COLLECTION_NAME, dimension: EMBEDDING_DIMENSIONS },
                );
            } catch (err) {
                // If the error is a dim mismatch, surface it loudly — the user
                // probably has a pre-existing collection at a different dim.
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(
                    `Could not provision '${COLLECTION_NAME}' collection (dim=${EMBEDDING_DIMENSIONS}). ${msg}`,
                );
            }
        })();
        return this.collectionReady;
    }

    // ── Public API ────────────────────────────────────────────────────────

    /**
     * Save a memory. Content is hashed to produce a stable id, so saving the
     * exact same content twice is a no-op (upsert).
     */
    async save(content: string): Promise<{ id: string; status: "saved" }> {
        if (!content.trim()) throw new Error("content is required");
        await this.ensureCollection();

        const id = `mem_${crypto
            .createHash("sha256")
            .update(content)
            .digest("hex")
            .substring(0, 16)}`;
        const vector = await this.embed(content);

        await this.request<{ inserted: number }>(
            "POST",
            `/api/vectordb/collections/${COLLECTION_NAME}/insert`,
            {
                documents: [
                    {
                        id,
                        vector,
                        content,
                        relativePath: "memory",
                        startLine: 0,
                        endLine: 0,
                        fileExtension: "",
                        metadata: {
                            source: "mcp",
                            createdAt: new Date().toISOString(),
                        },
                    } as VectorDocument,
                ],
            },
        );
        return { id, status: "saved" };
    }

    /**
     * Forget a memory. Tries exact-content match first (by hashing content to
     * the same id we'd have used on save); if that misses, falls back to
     * semantic search with a high similarity threshold.
     */
    async forget(
        content: string,
    ): Promise<{ success: boolean; message: string }> {
        if (!content.trim()) throw new Error("content is required");
        await this.ensureCollection();

        const id = `mem_${crypto
            .createHash("sha256")
            .update(content)
            .digest("hex")
            .substring(0, 16)}`;

        // Exact hash match
        try {
            await this.request<{ deleted: number }>(
                "POST",
                `/api/vectordb/collections/${COLLECTION_NAME}/delete`,
                { ids: [id] },
            );
            // The delete endpoint returns {deleted: 0} when id is absent and
            // {deleted: 1} when it hit — check via query to be sure.
            const rows = await this.queryByIds([id]);
            if (rows.length === 0) {
                return { success: true, message: `Forgot memory (exact match): ${id}` };
            }
            // Fall through to semantic search below
        } catch {
            // ignore, fall through
        }

        // Semantic fallback
        const SIM_THRESHOLD = 0.85;
        const search = await this.search(content, 5);
        const hit = search.results.find((m) => m.similarity >= SIM_THRESHOLD);
        if (!hit) {
            return {
                success: false,
                message: `No matching memory found (tried exact match + semantic search at similarity >= ${SIM_THRESHOLD}).`,
            };
        }
        await this.request<{ deleted: number }>(
            "POST",
            `/api/vectordb/collections/${COLLECTION_NAME}/delete`,
            { ids: [hit.id] },
        );
        return {
            success: true,
            message: `Forgot similar memory (similarity ${hit.similarity.toFixed(2)}): "${hit.memory.slice(0, 100)}"`,
        };
    }

    /**
     * Semantic search over saved memories.
     */
    async search(query: string, limit = 10): Promise<SearchResult> {
        if (!query.trim()) throw new Error("query is required");
        await this.ensureCollection();

        const start = Date.now();
        const queryVector = await this.embed(query);
        const res = await this.request<{ results: VectorSearchResult[] }>(
            "POST",
            `/api/vectordb/collections/${COLLECTION_NAME}/search`,
            { queryVector, topK: limit, filterExpr: null },
        );
        const results: Memory[] = (res?.results ?? []).map((r) => ({
            id: r.document.id,
            memory: r.document.content,
            similarity: r.score,
            createdAt: r.document.metadata?.createdAt as string | undefined,
        }));
        return { results, total: results.length, timing: Date.now() - start };
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private async queryByIds(ids: string[]): Promise<Array<{ id: string }>> {
        if (!ids.length) return [];
        const expr = `id in [${ids.map((id) => JSON.stringify(id)).join(",")}]`;
        try {
            const res = await this.request<{ rows: Array<{ id: string }> }>(
                "POST",
                `/api/vectordb/collections/${COLLECTION_NAME}/query`,
                { filterExpr: expr, outputFields: ["id"] },
            );
            return res?.rows ?? [];
        } catch {
            return [];
        }
    }
}
