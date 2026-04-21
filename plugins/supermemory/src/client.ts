/**
 * Thin client over the gateway's /api/plugins/supermemory/* endpoints.
 *
 * Embedding, ref-overlay scoping, and collection bootstrap all live server-side
 * now — this client just forwards save/forget/search calls with the caller's
 * API key.
 */

import { type PluginConfig } from "./config";

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

    constructor(config: PluginConfig) {
        this.baseUrl = config.gatewayUrl.replace(/\/$/, "");
        this.apiKey = config.gatewayApiKey;
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
        return (await res.json()) as T;
    }

    /** Save a memory. Server hashes content to a stable id, so re-saves are upserts. */
    async save(content: string): Promise<{ id: string; status: "saved" }> {
        if (!content.trim()) throw new Error("content is required");
        return this.request("POST", "/api/plugins/supermemory/save", { content });
    }

    /** Forget by exact-content hash; server scopes delete to the caller's own memories. */
    async forget(content: string): Promise<{ success: boolean; message: string }> {
        if (!content.trim()) throw new Error("content is required");

        // Try exact-content match first (server hashes content to the same id).
        const exact = await this.request<{ deleted: number }>(
            "POST",
            "/api/plugins/supermemory/forget",
            { content },
        );
        if (exact.deleted > 0) {
            return { success: true, message: "Forgot memory (exact match)" };
        }

        // Semantic fallback — find the closest match and delete it if above threshold.
        const SIM_THRESHOLD = 0.85;
        const search = await this.search(content, 5);
        const hit = search.results.find((m) => m.similarity >= SIM_THRESHOLD);
        if (!hit) {
            return {
                success: false,
                message: `No matching memory found (exact + semantic search at similarity >= ${SIM_THRESHOLD}).`,
            };
        }
        const byId = await this.request<{ deleted: number }>(
            "POST",
            "/api/plugins/supermemory/forget",
            { id: hit.id },
        );
        if (byId.deleted === 0) {
            return { success: false, message: "Semantic match belonged to another user or team — cannot forget." };
        }
        return {
            success: true,
            message: `Forgot similar memory (similarity ${hit.similarity.toFixed(2)}): "${hit.memory.slice(0, 100)}"`,
        };
    }

    /** Semantic search — server embeds the query and auto-scopes to the caller's refs. */
    async search(query: string, limit = 10): Promise<SearchResult> {
        if (!query.trim()) throw new Error("query is required");
        const start = Date.now();
        const res = await this.request<{
            results: Array<{ id: string; content: string; similarity: number; createdAt: string | null }>;
        }>("POST", "/api/plugins/supermemory/search", { query, limit });
        const results: Memory[] = res.results.map((r) => ({
            id: r.id,
            memory: r.content,
            similarity: r.similarity,
            createdAt: r.createdAt ?? undefined,
        }));
        return { results, total: results.length, timing: Date.now() - start };
    }
}
