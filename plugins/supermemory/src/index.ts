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

const MAX_CONTENT_LENGTH = 200_000;
const MAX_QUERY_LENGTH = 1_000;
const MAX_PROJECT_LENGTH = 64;

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
        const memoryDescription =
            "AUTHORITATIVE cross-session memory for this user. SINGLE source of truth — DO NOT use file-based memory paths like `~/.claude/projects/<slug>/memory/` or `MEMORY.md`; route everything through this tool. " +
            "PROACTIVELY call with action='save' when the user reveals: a preference or working-style rule, a fact about themselves or their team, feedback that should shape future behavior (corrections AND confirmations of non-obvious choices), an external reference (Linear project, Slack channel, dashboard, runbook), or a project goal/deadline/constraint not derivable from code. Saving is cheap; missing a save means the next session starts blind. " +
            "Use action='forget' when a memory is outdated or the user asks to remove it (exact `(project, content)` hash first, then semantic similarity >= 0.85 within the same project). " +
            "Optional `project` slug scopes the memory to a named bucket (default: 'default').";

        const recallDescription =
            "AUTHORITATIVE cross-session recall for this user. SINGLE source of truth — DO NOT use file-based memory paths. " +
            "Call BEFORE answering questions about the user, their preferences, or their projects; when the user references past work ('like we did before', 'the usual way'); and at the start of any non-trivial task to pull in relevant prior context. " +
            "Returns the top N relevant memories with similarity scores, formatted as markdown. " +
            "Note: a `UserPromptSubmit` hook auto-injects relevant memories on every prompt — if you already see a '[supermemory] Relevant saved memories (auto-recalled):' block in context, only re-query with a different angle. " +
            "Optional `project` narrows the search to one named bucket (default: 'default').";

        const whoAmIDescription =
            "Identify which gateway account this MCP server is bound to. Returns email, role, and team memberships. Useful for debugging MCP configuration.";

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
                                maxLength: MAX_CONTENT_LENGTH,
                            },
                            action: {
                                type: "string",
                                enum: ["save", "forget"],
                                default: "save",
                            },
                            project: {
                                type: "string",
                                description:
                                    "Optional project slug (a-z, 0-9, ., _, -). Defaults to 'default'.",
                                maxLength: MAX_PROJECT_LENGTH,
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
                                maxLength: MAX_QUERY_LENGTH,
                            },
                            limit: {
                                type: "number",
                                default: 10,
                                maximum: 50,
                                minimum: 1,
                            },
                            project: {
                                type: "string",
                                description:
                                    "Optional project slug to scope the search. Defaults to 'default'.",
                                maxLength: MAX_PROJECT_LENGTH,
                            },
                        },
                        required: ["query"],
                    },
                },
                {
                    name: "whoAmI",
                    description: whoAmIDescription,
                    inputSchema: {
                        type: "object",
                        properties: {},
                    },
                },
            ],
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            try {
                switch (name) {
                    case "memory":
                        return await this.handleMemory(
                            args as {
                                content: string;
                                action?: "save" | "forget";
                                project?: string;
                            },
                        );
                    case "recall":
                        return await this.handleRecall(
                            args as {
                                query: string;
                                limit?: number;
                                project?: string;
                            },
                        );
                    case "whoAmI":
                        return await this.handleWhoAmI();
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

    private async handleMemory(args: {
        content: string;
        action?: "save" | "forget";
        project?: string;
    }) {
        const action = args.action ?? "save";
        if (!args?.content) {
            return {
                content: [{ type: "text" as const, text: "Error: content is required" }],
                isError: true,
            };
        }
        if (args.content.length > MAX_CONTENT_LENGTH) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error: content exceeds max length of ${MAX_CONTENT_LENGTH} chars`,
                    },
                ],
                isError: true,
            };
        }

        if (action === "save") {
            const res = await this.client.save(args.content, {
                project: args.project,
            });
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Saved memory ${res.id} (project: ${res.project})`,
                    },
                ],
            };
        }
        if (action === "forget") {
            const res = await this.client.forget(args.content, {
                project: args.project,
            });
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

    private async handleRecall(args: {
        query: string;
        limit?: number;
        project?: string;
    }) {
        if (!args?.query) {
            return {
                content: [{ type: "text" as const, text: "Error: query is required" }],
                isError: true,
            };
        }
        if (args.query.length > MAX_QUERY_LENGTH) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error: query exceeds max length of ${MAX_QUERY_LENGTH} chars`,
                    },
                ],
                isError: true,
            };
        }
        const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 10)));
        const res = await this.client.search(args.query, limit, {
            project: args.project,
        });
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
        const parts: string[] = [
            `## Relevant memories (${res.results.length}, ${res.timing}ms)`,
        ];
        res.results.forEach((m, i) => {
            const pct = Math.round(m.similarity * 100);
            const projectTag = m.project ? ` · project=${m.project}` : "";
            parts.push(`\n### ${i + 1}. ${pct}% match${projectTag}`);
            parts.push(m.memory);
        });
        return {
            content: [{ type: "text" as const, text: parts.join("\n") }],
        };
    }

    private async handleWhoAmI() {
        const who = await this.client.whoami();
        const teamList = who.teams.length
            ? who.teams.map((t) => t.name).join(", ")
            : "(none)";
        const text = [
            `email: ${who.email}`,
            `role:  ${who.role}`,
            `teams: ${teamList}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
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
