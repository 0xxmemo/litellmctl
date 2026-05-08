import { Server, Layers } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EndpointTryCard, useApiKey } from "@/components/endpoint-try-card";
import { ModelsList } from "@/components/models-list";
import { useExtendedModels } from "@/lib/models-hooks";
import { ConfigContainer } from "@/components/config";

// ─── Dynamic URL helper ────────────────────────────────────────────────────────

function getBaseUrl(): string {
  if (typeof window === "undefined") return "http://localhost:14041";
  return `${window.location.protocol}//${window.location.host}`;
}

// ─── Build endpoint definitions with dynamic URLs ─────────────────────────────

function buildEndpoints(baseUrl: string) {
  return [
    {
      method: "GET",
      path: "/v1/models",
      description: "List available models (public, no auth required)",
      requiresAuth: false,
      curlExample: `curl ${baseUrl}/v1/models`,
      bodyNote:
        "GET request — no body needed. Public endpoint, no API key required.",
    },
    {
      method: "POST",
      path: "/v1/chat/completions",
      description: 'Chat completions — OpenAI format (supports "stream": true)',
      requiresAuth: true,
      defaultModel: "ultra",
      allowedModes: ['chat', 'responses'],
      curlExample: `curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "ultra",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
      defaultBody: JSON.stringify(
        {
          model: "ultra",
          messages: [{ role: "user", content: "Hello!" }],
        },
        null,
        2,
      ),
    },
    {
      method: "POST",
      path: "/v1/messages",
      description: "Chat completions — Anthropic format (Claude's native API)",
      requiresAuth: true,
      defaultModel: "ultra",
      allowedModes: ['chat', 'responses'],
      curlExample: `curl ${baseUrl}/v1/messages \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "ultra",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
      defaultBody: JSON.stringify(
        {
          model: "ultra",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Hello!" }],
        },
        null,
        2,
      ),
    },
    {
      method: "POST",
      path: "/v1/embeddings",
      description:
        "Text embeddings — AWS Bedrock Titan Embed v2 (Matryoshka), 1024-d default",
      requiresAuth: true,
      defaultModel: "bedrock/titan-embed-v2",
      allowedModes: ['embedding'],
      curlExample: `curl ${baseUrl}/v1/embeddings \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "bedrock/titan-embed-v2",
    "input": "The quick brown fox",
    "dimensions": 1024
  }'`,
      defaultBody: JSON.stringify(
        {
          model: "bedrock/titan-embed-v2",
          input: "The quick brown fox",
          dimensions: 1024,
        },
        null,
        2,
      ),
      bodyNote:
        "Optional `dimensions` selects output width when the backend supports it. Titan v2 accepts 256, 512, or 1024 only. See Available Models for typical values; omit the key to use the deployment default.",
    },
    {
      method: "POST",
      path: "/v1/images/generations",
      description:
        "Image generation — requires an image model configured in /v1/models",
      requiresAuth: true,
      defaultModel: "ultra",
      allowedModes: ['image_generation'],
      curlExample: `curl ${baseUrl}/v1/images/generations \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "ultra",
    "prompt": "A cute cat",
    "n": 1,
    "size": "1024x1024"
  }'`,
      defaultBody: JSON.stringify(
        {
          model: "ultra",
          prompt: "A cute cat",
          n: 1,
          size: "1024x1024",
        },
        null,
        2,
      ),
      bodyNote:
        'Endpoint is live. Uses "ultra" model. Ensure the model is configured for image generation in your LiteLLM config.',
    },
    {
      method: "POST",
      path: "/v1/audio/transcriptions",
      description:
        "Speech-to-text — local faster-whisper models (free, runs on-device)",
      requiresAuth: true,
      defaultModel: "local/whisper",
      allowedModes: ['audio_transcription'],
      curlExample: `# Multipart form-data (standard)
curl ${baseUrl}/v1/audio/transcriptions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -F "file=@audio.mp3" \\
  -F "model=local/whisper"

# JSON with base64-encoded file (Try tab format)
curl ${baseUrl}/v1/audio/transcriptions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"file":"data:audio/mp3;base64,<BASE64_DATA>","model":"local/whisper"}'`,
      defaultBody: JSON.stringify(
        {
          file: "data:audio/mp3;base64,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",
      model: "local/whisper",
      language: "en",
      response_format: "json",
    },
    null,
    2,
  ),
      bodyNote:
        "Includes a sample 1-second 440Hz test tone MP3 (base64). Replace the file value with your own audio. Available models: local/whisper, local/whisper-large-v3, local/whisper-large-v3-turbo, local/distil-whisper-large-v3.",
    },
    {
      method: "GET",
      path: "/api/health",
      description:
        "Health check — status, uptime, and available features",
      requiresAuth: false,
      curlExample: `curl ${baseUrl}/api/health | jq .

# Check if specific features are available
curl ${baseUrl}/api/health | jq '.features | {search, embedding, transcription, proton, database}'`,
      bodyNote:
        "GET request — no authentication required. Returns { status, uptime, features: { search, embedding, transcription, proton, database } }. Use this to check which optional services are running.",
    },
    {
      method: "GET",
      path: "/api/search",
      description:
        "Privacy-respecting search via SearXNG (requires authentication)",
      requiresAuth: true,
      hasQueryParams: true,
      curlExample: `# Search for a topic
curl "${baseUrl}/api/search?q=machine+learning" \\
  -H "Authorization: Bearer YOUR_API_KEY" | jq '.results[:3]'

# Search with filters
curl "${baseUrl}/api/search?q=Python&categories=programming&language=en" \\
  -H "Authorization: Bearer YOUR_API_KEY" | jq '.results[:3] | .[] | {title, url, snippet}'`,
      bodyNote:
        "GET request — requires authentication. Proxies to SearXNG (http://localhost:8888/search). Supports all SearXNG query parameters: q, categories, language, time_range, etc. Requires SearXNG to be running (check /api/health).",
    },
  ];
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function Docs() {
  const { apiKey } = useApiKey();
  const extendedModels = useExtendedModels();
  const baseUrl = getBaseUrl();
  const endpoints = buildEndpoints(baseUrl);

  return (
    <div className="prose dark:prose-invert max-w-4xl mx-auto p-4 sm:p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">API Documentation</h1>
        <p className="text-muted-foreground">
          OpenAI-compatible API — configure your client and start making requests
        </p>
      </div>

      {/* ── Config Widget (Collapsible) ── */}
      <div className="mb-8">
        <ConfigContainer />
      </div>

      {/* ── Available Models ── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            Available Models
          </CardTitle>
          <CardDescription>
            Live list fetched from <code>/v1/models</code> — public endpoint, no
            auth required. Embedding models list common <code>dimensions</code>{' '}
            choices when known; omit the field to use the deployment default.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ModelsList extendedModels={extendedModels} />
        </CardContent>
      </Card>

      {/* ── All API Endpoints ── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            API Endpoints
          </CardTitle>
          <CardDescription>
            Each endpoint has a <strong>curl</strong> tab for copy-paste
            examples and a <strong>Try</strong> tab to send live requests
            directly from your browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {endpoints.map((ep) => (
            <EndpointTryCard
              key={ep.path + ep.description}
              method={ep.method}
              path={ep.path}
              description={ep.description}
              curlExample={ep.curlExample}
              defaultBody={"defaultBody" in ep ? ep.defaultBody : undefined}
              bodyNote={"bodyNote" in ep ? ep.bodyNote : undefined}
              apiKey={apiKey}
              requiresAuth={ep.requiresAuth}
              defaultModel={"defaultModel" in ep ? ep.defaultModel : undefined}
              allowedModes={"allowedModes" in ep ? ep.allowedModes : undefined}
              hasQueryParams={"hasQueryParams" in ep ? ep.hasQueryParams : undefined}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
