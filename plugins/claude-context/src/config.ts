/**
 * LiteLLM plugin MCP config — stripped down to only the env vars we use.
 */

export interface ContextMcpConfig {
    name: string;
    version: string;
    gatewayUrl: string;
    gatewayApiKey: string;
    embeddingModel: string;
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

export function createMcpConfig(): ContextMcpConfig {
    const gatewayUrl = requireEnv('LLM_GATEWAY_URL');
    const gatewayApiKey = requireEnv('LLM_GATEWAY_API_KEY');
    const embeddingModel = process.env.EMBEDDING_MODEL || 'local/nomic-embed-text';
    const stateDir = process.env.CLAUDE_CONTEXT_STATE_DIR
        || `${process.env.HOME}/.litellm/plugin-state/claude-context`;

    return {
        name: process.env.MCP_SERVER_NAME || 'claude-context',
        version: process.env.MCP_SERVER_VERSION || '1.0.0',
        gatewayUrl,
        gatewayApiKey,
        embeddingModel,
        stateDir,
    };
}

export function logConfigurationSummary(config: ContextMcpConfig): void {
    console.log(`[MCP] Starting ${config.name} v${config.version}`);
    console.log(`[MCP]   Gateway URL:     ${config.gatewayUrl}`);
    console.log(`[MCP]   Embedding model: ${config.embeddingModel}`);
    console.log(`[MCP]   State dir:       ${config.stateDir}`);
}

export function showHelpMessage(): void {
    console.log(`
claude-context (LiteLLM plugin)

Usage: bun run index.ts

Required env:
  LLM_GATEWAY_URL       e.g. http://localhost:14041
  LLM_GATEWAY_API_KEY   User's gateway API key

Optional env:
  EMBEDDING_MODEL             Default: local/nomic-embed-text
  CLAUDE_CONTEXT_STATE_DIR    Default: ~/.litellm/plugin-state/claude-context
  EMBEDDING_BATCH_SIZE        Default: 64
  CUSTOM_EXTENSIONS           Comma-separated extra extensions
  CUSTOM_IGNORE_PATTERNS      Comma-separated extra ignore patterns
`);
}
