/**
 * LiteLLM plugin MCP config.
 *
 * The embedding model and dimensions are FIXED by the LiteLLM control plane —
 * they are NOT user-configurable. Changing them per-user would fragment the
 * vector store (one vec0 table per dim) and invalidate existing indexes.
 */

export const EMBEDDING_MODEL = 'local/nomic-embed-text';
export const EMBEDDING_DIMENSIONS = 512;

export interface ContextMcpConfig {
    name: string;
    version: string;
    gatewayUrl: string;
    gatewayApiKey: string;
    stateDir: string;
}

// Legacy snapshot types kept for backward compatibility in snapshot.ts.
export interface CodebaseSnapshotV1 {
    indexedCodebases: string[];
    indexingCodebases: string[] | Record<string, number>;
    lastUpdated: string;
}

interface CodebaseInfoBase {
    lastUpdated: string;
}

export interface CodebaseInfoIndexing extends CodebaseInfoBase {
    status: 'indexing';
    indexingPercentage: number;
}

export interface CodebaseInfoIndexed extends CodebaseInfoBase {
    status: 'indexed';
    indexedFiles: number;
    totalChunks: number;
    indexStatus: 'completed' | 'limit_reached';
}

export interface CodebaseInfoIndexFailed extends CodebaseInfoBase {
    status: 'indexfailed';
    errorMessage: string;
    lastAttemptedPercentage?: number;
}

export type CodebaseInfo = CodebaseInfoIndexing | CodebaseInfoIndexed | CodebaseInfoIndexFailed;

export interface CodebaseSnapshotV2 {
    formatVersion: 'v2';
    codebases: Record<string, CodebaseInfo>;
    lastUpdated: string;
}

export type CodebaseSnapshot = CodebaseSnapshotV1 | CodebaseSnapshotV2;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v || !v.trim()) {
        console.error(`[config] ${name} is required but not set`);
        process.exit(1);
    }
    return v;
}

// TODO: Prefer LITELLMCTL_URL / LITELLMCTL_API_KEY once deployments migrate; keep LLM_GATEWAY_* as canonical for now.
export function createMcpConfig(): ContextMcpConfig {
    const gatewayUrl = requireEnv('LLM_GATEWAY_URL');
    const gatewayApiKey = requireEnv('LLM_GATEWAY_API_KEY');
    const stateDir = process.env.CLAUDE_CONTEXT_STATE_DIR
        || `${process.env.HOME}/.litellm/plugin-state/claude-context`;

    return {
        name: process.env.MCP_SERVER_NAME || 'claude-context',
        version: process.env.MCP_SERVER_VERSION || '1.0.0',
        gatewayUrl,
        gatewayApiKey,
        stateDir,
    };
}

export function logConfigurationSummary(config: ContextMcpConfig): void {
    console.log(`[MCP] Starting ${config.name} v${config.version}`);
    console.log(`[MCP]   Gateway URL:     ${config.gatewayUrl}`);
    console.log(`[MCP]   Embedding model: ${EMBEDDING_MODEL} (fixed)`);
    console.log(`[MCP]   Dimensions:      ${EMBEDDING_DIMENSIONS} (fixed)`);
    console.log(`[MCP]   State dir:       ${config.stateDir}`);
}

export function showHelpMessage(): void {
    console.log(`
claude-context (LiteLLM plugin)

Usage: bun run index.ts

Required env:
  LLM_GATEWAY_URL       e.g. http://localhost:14041
  LLM_GATEWAY_API_KEY   User's gateway API key
  (TODO: document LITELLMCTL_* aliases when we switch defaults.)

Optional env:
  CLAUDE_CONTEXT_STATE_DIR    Default: ~/.litellm/plugin-state/claude-context
  EMBEDDING_BATCH_SIZE        Default: 64
  CUSTOM_EXTENSIONS           Comma-separated extra extensions
  CUSTOM_IGNORE_PATTERNS      Comma-separated extra ignore patterns

Embedding model (${EMBEDDING_MODEL}) and dimensions (${EMBEDDING_DIMENSIONS})
are fixed by the LiteLLM control plane and cannot be overridden.
`);
}
