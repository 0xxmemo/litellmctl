#!/usr/bin/env bun

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY so stdio MCP protocol
// (which is JSON-over-stdout) is not polluted by log lines.
console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};
console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { Context } from "./core/context";
import { GatewayVectorDatabase } from "./core/vectordb/gateway-vectordb";
import { LiteLLMEmbedding } from "./core/embedding/litellm-embedding";
import { LangChainCodeSplitter } from "./core/splitter";

import {
    createMcpConfig,
    logConfigurationSummary,
    showHelpMessage,
    ContextMcpConfig,
    EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS,
} from "./config";
import { SnapshotManager } from "./snapshot";
import { SyncManager } from "./sync";
import { ToolHandlers } from "./handlers";

class ContextMcpServer {
    private server: Server;
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private toolHandlers: ToolHandlers;

    constructor(config: ContextMcpConfig) {
        this.server = new Server(
            { name: config.name, version: config.version },
            { capabilities: { tools: {} } },
        );

        const embedding = new LiteLLMEmbedding({
            baseUrl: config.gatewayUrl,
            apiKey: config.gatewayApiKey,
            model: EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIMENSIONS,
        });

        const vectorDatabase = new GatewayVectorDatabase({
            baseUrl: config.gatewayUrl,
            apiKey: config.gatewayApiKey,
        });

        this.context = new Context({
            embedding,
            vectorDatabase,
            codeSplitter: new LangChainCodeSplitter(1000, 200),
        });

        this.snapshotManager = new SnapshotManager();
        this.syncManager = new SyncManager(this.context, this.snapshotManager);
        this.toolHandlers = new ToolHandlers(this.context, this.snapshotManager);

        this.snapshotManager.loadCodebaseSnapshot();
        this.setupTools();
    }

    private setupTools() {
        const indexDescription = `Index a codebase directory for semantic search.

⚠️ **IMPORTANT**:
- Provide an absolute path.

Typical workflow: call this before search_code when the codebase isn't indexed yet.`;

        const searchDescription = `Search the indexed codebase using natural language queries.

⚠️ **IMPORTANT**:
- Provide an absolute path.

Use for: finding code, gathering context, locating implementations, reviewing related code, refactoring, duplicate detection.`;

        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "index_codebase",
                    description: indexDescription,
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "ABSOLUTE path to the codebase directory." },
                            force: { type: "boolean", description: "Force re-indexing.", default: false },
                            splitter: { type: "string", enum: ["langchain"], default: "langchain" },
                            customExtensions: { type: "array", items: { type: "string" }, default: [] },
                            ignorePatterns: { type: "array", items: { type: "string" }, default: [] },
                        },
                        required: ["path"],
                    },
                },
                {
                    name: "search_code",
                    description: searchDescription,
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "ABSOLUTE path to the codebase." },
                            query: { type: "string", description: "Natural language query." },
                            limit: { type: "number", default: 10, maximum: 50 },
                            extensionFilter: { type: "array", items: { type: "string" }, default: [] },
                        },
                        required: ["path", "query"],
                    },
                },
                {
                    name: "clear_index",
                    description: "Clear the search index for a codebase (absolute path required).",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "ABSOLUTE path." },
                        },
                        required: ["path"],
                    },
                },
                {
                    name: "get_indexing_status",
                    description: "Report indexing status / progress for a codebase.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "ABSOLUTE path." },
                        },
                        required: ["path"],
                    },
                },
            ],
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            switch (name) {
                case "index_codebase":
                    return await this.toolHandlers.handleIndexCodebase(args);
                case "search_code":
                    return await this.toolHandlers.handleSearchCode(args);
                case "clear_index":
                    return await this.toolHandlers.handleClearIndex(args);
                case "get_indexing_status":
                    return await this.toolHandlers.handleGetIndexingStatus(args);
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async start() {
        console.log('[MCP] start()');
        await this.toolHandlers.validateLegacyZeroEntries();
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.log('[MCP] listening on stdio');
        this.syncManager.startBackgroundSync();
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    // Subcommand dispatch — first non-flag arg switches to one-shot CLI mode.
    const sub = args[0];
    if (sub && !sub.startsWith('-')) {
        const { runCli } = await import('./cli');
        await runCli(args);
        return; // runCli calls process.exit
    }

    const config = createMcpConfig();
    logConfigurationSummary(config);

    const server = new ContextMcpServer(config);
    await server.start();
}

process.on('SIGINT', () => { console.error("SIGINT, shutting down"); process.exit(0); });
process.on('SIGTERM', () => { console.error("SIGTERM, shutting down"); process.exit(0); });

main().catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
});
