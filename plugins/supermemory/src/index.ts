#!/usr/bin/env bun

// stdout is reserved for MCP JSON protocol; push all logs to stderr.
console.log = (...args: any[]) => {
    process.stderr.write("[LOG] " + args.join(" ") + "\n");
};
console.warn = (...args: any[]) => {
    process.stderr.write("[WARN] " + args.join(" ") + "\n");
};

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createConfig, logSummary, showHelp, type PluginConfig } from "./config";
import { MemoryClient } from "./client";

class SupermemoryMcpServer {
    private server: Server;
    private client: MemoryClient;

    constructor(config: PluginConfig) {
        this.server = new Server(
            { name: config.name, version: config.version },
            { capabilities: { tools: {} } },
        );
        this.client = new MemoryClient(config);
        this.setupTools();
    }

    private setupTools() {
        const memoryDescription = `Save or forget a memory. Use 'save' when the user shares a preference, fact, goal, or anything worth remembering across conversations. Use 'forget' when a memory is outdated or the user asks to remove it. Forget resolves by exact content match first, then semantic similarity (threshold 0.85).`;

        const recallDescription = `Search saved memories using natural language. Returns the top N most relevant memories with similarity scores. Use this before answering questions about the user to pull in relevant long-term context.`;

        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "memory",
                    description: memoryDescription,
                    inputSchema: {
                        type: "object",
                        properties: {
                            content: {
                                type: "string",
                                description:
                                    "The memory content to save or forget (e.g. 'User prefers dark mode').",
                            },
                            action: {
                                type: "string",
                                enum: ["save", "forget"],
                                default: "save",
                            },
                        },
                        required: ["content"],
                    },
                },
                {
                    name: "recall",
                    description: recallDescription,
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "Natural language query to search saved memories.",
                            },
                            limit: {
                                type: "number",
                                default: 10,
                                maximum: 50,
                            },
                        },
                        required: ["query"],
                    },
                },
            ],
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            try {
                switch (name) {
                    case "memory":
                        return await this.handleMemory(args as { content: string; action?: "save" | "forget" });
                    case "recall":
                        return await this.handleRecall(args as { query: string; limit?: number });
                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${message}` }],
                    isError: true,
                };
            }
        });
    }

    private async handleMemory(args: { content: string; action?: "save" | "forget" }) {
        const action = args.action ?? "save";
        if (!args?.content) {
            return {
                content: [{ type: "text" as const, text: "Error: content is required" }],
                isError: true,
            };
        }
        if (action === "save") {
            const res = await this.client.save(args.content);
            return {
                content: [{ type: "text" as const, text: `Saved memory ${res.id}` }],
            };
        }
        if (action === "forget") {
            const res = await this.client.forget(args.content);
            return {
                content: [{ type: "text" as const, text: res.message }],
                isError: !res.success,
            };
        }
        return {
            content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
            isError: true,
        };
    }

    private async handleRecall(args: { query: string; limit?: number }) {
        if (!args?.query) {
            return {
                content: [{ type: "text" as const, text: "Error: query is required" }],
                isError: true,
            };
        }
        const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 10)));
        const res = await this.client.search(args.query, limit);
        if (res.results.length === 0) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `No memories matched. (${res.timing}ms)`,
                    },
                ],
            };
        }
        const lines = res.results.map(
            (m, i) =>
                `${i + 1}. [${m.similarity.toFixed(3)}] ${m.memory}`,
        );
        const body = `Recalled ${res.results.length} memories (${res.timing}ms):\n${lines.join("\n")}`;
        return {
            content: [{ type: "text" as const, text: body }],
        };
    }

    async start() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.log("[MCP] supermemory listening on stdio");
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        showHelp();
        process.exit(0);
    }
    const config = createConfig();
    logSummary(config);
    const server = new SupermemoryMcpServer(config);
    await server.start();
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
