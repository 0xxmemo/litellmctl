/**
 * supermemory plugin config.
 *
 * Embedding model and dimensions are FIXED by the LiteLLM control plane
 * to match claude-context — one dimension across the whole gateway keeps
 * the per-dim vec0 tables from fragmenting.
 */

export const EMBEDDING_MODEL = "bedrock/titan-embed-v2";
export const EMBEDDING_DIMENSIONS = 1024;
export const COLLECTION_NAME = "memories";

export interface PluginConfig {
    name: string;
    version: string;
    gatewayUrl: string;
    gatewayApiKey: string;
}

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v || !v.trim()) {
        console.error(`[config] ${name} is required but not set`);
        process.exit(1);
    }
    return v;
}

// TODO: Prefer LITELLMCTL_URL / LITELLMCTL_API_KEY once deployments migrate; keep LLM_GATEWAY_* as canonical for now.
export function createConfig(): PluginConfig {
    return {
        name: process.env.MCP_SERVER_NAME || "supermemory",
        version: process.env.MCP_SERVER_VERSION || "1.0.0",
        gatewayUrl: requireEnv("LLM_GATEWAY_URL"),
        gatewayApiKey: requireEnv("LLM_GATEWAY_API_KEY"),
    };
}

export function logSummary(config: PluginConfig): void {
    console.log(`[MCP] Starting ${config.name} v${config.version}`);
    console.log(`[MCP]   Gateway URL:     ${config.gatewayUrl}`);
    console.log(`[MCP]   Embedding model: ${EMBEDDING_MODEL} (fixed)`);
    console.log(`[MCP]   Dimensions:      ${EMBEDDING_DIMENSIONS} (fixed)`);
    console.log(`[MCP]   Collection:      ${COLLECTION_NAME}`);
}

export function showHelp(): void {
    console.log(`
supermemory (LiteLLM plugin)

Usage: bun run src/index.ts

Required env:
  LLM_GATEWAY_URL       e.g. http://localhost:14041
  LLM_GATEWAY_API_KEY   User's gateway API key
  (TODO: document LITELLMCTL_* aliases when we switch defaults.)

Embedding model (${EMBEDDING_MODEL}) and dimensions (${EMBEDDING_DIMENSIONS})
are fixed by the LiteLLM control plane.
`);
}
