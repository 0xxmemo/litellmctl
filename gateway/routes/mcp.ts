/**
 * Native MCP (Model Context Protocol) endpoint.
 *
 * Exposes gateway capabilities as MCP tools that Claude Code / other MCP
 * clients can consume directly over HTTP. Clients register:
 *
 *   {"mcpServers":{"litellm":{"type":"http","url":"https://.../mcp",
 *      "headers":{"Authorization":"Bearer sk-llm-..."}}}}
 *
 * Currently exposes `generate_image` backed by /v1/images/generations.
 * Stateless — no session tracking required.
 */

import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import { errorMessage } from "../lib/errors";
import { extractApiKey } from "../lib/auth";
import { requireUser, validateApiKey, trackUsage } from "../lib/db";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "litellm-gateway", version: "1.0.0" };

const TOOLS = [
  {
    name: "generate_image",
    description:
      "Generate an image from a text prompt using Google's Nano Banana (Gemini) image models. Returns the image inline as base64. Use this when the user asks for an illustration, icon, banner, photo, diagram, or any other visual.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate.",
        },
        model: {
          type: "string",
          enum: ["nano-banana-pro", "nano-banana"],
          description:
            "nano-banana-pro = gemini-3-pro-image-preview (higher quality, landscape JPEG ~1408x768). nano-banana = gemini-2.5-flash-image (faster, square PNG 1024x1024). Defaults to nano-banana-pro.",
        },
        n: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "Number of images to generate. Default 1.",
        },
      },
      required: ["prompt"],
    },
  },
];

const MODEL_MAP: Record<string, string> = {
  "nano-banana-pro": "google/nano-banana-pro",
  "nano-banana": "google/nano-banana",
};

type JsonRpcId = number | string | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: any;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

function rpcResult(id: JsonRpcId, result: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: any,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function sniffImageMime(b64: string): string {
  try {
    const bin = atob(b64.slice(0, 16));
    const b0 = bin.charCodeAt(0);
    const b1 = bin.charCodeAt(1);
    const b2 = bin.charCodeAt(2);
    const b3 = bin.charCodeAt(3);
    if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return "image/jpeg";
    if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return "image/png";
    if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) return "image/webp";
  } catch {}
  return "image/png";
}

async function callGenerateImage(
  args: { prompt?: unknown; model?: unknown; n?: unknown },
  email: string,
  keyHash: string | null,
): Promise<any> {
  if (typeof args.prompt !== "string" || !args.prompt.trim()) {
    return {
      content: [{ type: "text", text: "prompt is required and must be a non-empty string." }],
      isError: true,
    };
  }
  const shortName = typeof args.model === "string" ? args.model : "nano-banana-pro";
  const realModel = MODEL_MAP[shortName];
  if (!realModel) {
    return {
      content: [
        {
          type: "text",
          text: `Unknown model '${shortName}'. Valid: ${Object.keys(MODEL_MAP).join(", ")}`,
        },
      ],
      isError: true,
    };
  }
  const n = Math.min(Math.max(typeof args.n === "number" ? args.n : 1, 1), 4);

  const upstream = await fetch(`${LITELLM_URL}/v1/images/generations`, {
    method: "POST",
    headers: { Authorization: LITELLM_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ model: realModel, prompt: args.prompt, n }),
  });

  if (!upstream.ok) {
    const body = await upstream.text();
    return {
      content: [
        {
          type: "text",
          text: `Image generation failed (HTTP ${upstream.status}): ${body.slice(0, 600)}`,
        },
      ],
      isError: true,
    };
  }

  const data: any = await upstream.json();
  const images: any[] = Array.isArray(data?.data) ? data.data : [];
  if (images.length === 0) {
    return {
      content: [{ type: "text", text: "Upstream returned no images." }],
      isError: true,
    };
  }

  const usage = data?.usage;
  if (usage && typeof usage === "object") {
    trackUsage(
      email,
      realModel,
      usage.input_tokens ?? usage.prompt_tokens ?? 0,
      usage.output_tokens ?? usage.completion_tokens ?? 0,
      keyHash,
      realModel,
      "/mcp/generate_image",
    );
  }

  const content: any[] = [
    {
      type: "text",
      text: `Generated ${images.length} image(s) with ${realModel}.`,
    },
  ];
  for (const img of images) {
    const b64 = typeof img?.b64_json === "string" ? img.b64_json : "";
    if (!b64) continue;
    content.push({ type: "image", data: b64, mimeType: sniffImageMime(b64) });
  }
  return { content };
}

async function dispatch(
  rpc: JsonRpcRequest,
  email: string,
  keyHash: string | null,
): Promise<JsonRpcResponse | null> {
  const id: JsonRpcId = rpc.id ?? null;
  switch (rpc.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion:
          typeof rpc.params?.protocolVersion === "string"
            ? rpc.params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      // Notifications — no response.
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const name = rpc.params?.name;
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
      if (name !== "generate_image") {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      try {
        const result = await callGenerateImage(args as any, email, keyHash);
        return rpcResult(id, result);
      } catch (err) {
        return rpcError(id, -32603, `Internal error: ${errorMessage(err)}`);
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${rpc.method}`);
  }
}

async function mcpHandler(req: Request): Promise<Response> {
  try {
    const auth = await requireUser(req);
    if (auth instanceof Response) return auth;

    let keyHash: string | null = null;
    const apiKey = extractApiKey(req);
    if (apiKey) {
      const kr = validateApiKey(apiKey);
      if (kr) keyHash = kr.keyHash;
    }

    const text = await req.text();
    let parsed: JsonRpcRequest | JsonRpcRequest[];
    try {
      parsed = JSON.parse(text);
    } catch {
      return Response.json(rpcError(null, -32700, "Parse error"));
    }

    if (Array.isArray(parsed)) {
      const responses: JsonRpcResponse[] = [];
      for (const r of parsed) {
        const res = await dispatch(r, auth.email, keyHash);
        if (res) responses.push(res);
      }
      if (responses.length === 0) return new Response(null, { status: 202 });
      return Response.json(responses);
    }

    const res = await dispatch(parsed, auth.email, keyHash);
    if (!res) return new Response(null, { status: 202 });
    return Response.json(res);
  } catch (err) {
    console.error("[mcp]", errorMessage(err));
    return Response.json(rpcError(null, -32603, "Internal error"), { status: 500 });
  }
}

function mcpGet(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  });
}

export const mcpRoutes = {
  "/mcp": { POST: mcpHandler, GET: mcpGet },
};
