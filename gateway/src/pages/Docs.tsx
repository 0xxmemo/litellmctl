import { useState, useEffect } from 'react'
import { Key, Server, Layers, Terminal, Check, Copy } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ApiKeyInput, EndpointTryCard, useApiKey } from '@/components/EndpointTryCard'
import { ModelsList } from '@/components/ModelsList'
import { useExtendedModels } from '@/lib/models-hooks'

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({
  text,
  substitutions,
  className,
  label,
}: {
  text: string
  substitutions?: Record<string, string>
  className?: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      let content = text
      if (substitutions) {
        for (const [placeholder, value] of Object.entries(substitutions)) {
          content = content.split(placeholder).join(value)
        }
      }
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* fallback: do nothing */
    }
  }

  if (label) {
    return (
      <Button
        variant="outline"
        size="sm"
        className={`gap-1.5 text-xs ${className ?? ''}`}
        onClick={handleCopy}
      >
        {copied ? (
          <><Check className="h-3.5 w-3.5 text-green-500" /> Copied!</>
        ) : (
          <><Copy className="h-3.5 w-3.5" /> {label}</>
        )}
      </Button>
    )
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-7 w-7 ${className ?? ''}`}
      onClick={handleCopy}
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  )
}

// ─── All endpoint definitions ─────────────────────────────────────────────────

const ENDPOINTS = [
  {
    method: 'GET',
    path: '/v1/models',
    description: 'List available models (public, no auth required)',
    requiresAuth: false,
    curlExample: `curl https://llm.0xmemo.com/v1/models`,
    bodyNote: 'GET request — no body needed. Public endpoint, no API key required.',
  },
  {
    method: 'POST',
    path: '/v1/chat/completions',
    description: 'Chat completions — OpenAI format (supports "stream": true)',
    requiresAuth: true,
    defaultModel: 'anthropic/claude-sonnet-4-6',
    curlExample: `curl https://llm.0xmemo.com/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "anthropic/claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
    defaultBody: JSON.stringify(
      { model: 'anthropic/claude-sonnet-4-6', messages: [{ role: 'user', content: 'Hello!' }] },
      null,
      2
    ),
  },
  {
    method: 'POST',
    path: '/v1/messages',
    description: "Chat completions — Anthropic format (Claude's native API)",
    requiresAuth: true,
    defaultModel: 'anthropic/claude-sonnet-4-6',
    curlExample: `curl https://llm.0xmemo.com/v1/messages \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "anthropic/claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
    defaultBody: JSON.stringify(
      { model: 'anthropic/claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: 'Hello!' }] },
      null,
      2
    ),
  },
  {
    method: 'POST',
    path: '/v1/embeddings',
    description: 'Text embeddings — local Ollama embedding models (free, no token cost)',
    requiresAuth: true,
    defaultModel: 'local/nomic-embed-text',
    curlExample: `curl https://llm.0xmemo.com/v1/embeddings \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "local/nomic-embed-text",
    "input": "The quick brown fox"
  }'`,
    defaultBody: JSON.stringify(
      { model: 'local/nomic-embed-text', input: 'The quick brown fox' },
      null,
      2
    ),
    bodyNote: 'Uses local Ollama embedding models (zero cost). Available: local/nomic-embed-text, local/mxbai-embed-large, local/bge-m3, local/all-minilm.',
  },
  {
    method: 'POST',
    path: '/v1/images/generations',
    description: 'Image generation — requires an image model configured in /v1/models',
    requiresAuth: true,
    defaultModel: 'anthropic/claude-opus-4-6',
    curlExample: `curl https://llm.0xmemo.com/v1/images/generations \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "anthropic/claude-opus-4-6",
    "prompt": "A cute cat",
    "n": 1,
    "size": "1024x1024"
  }'`,
    defaultBody: JSON.stringify(
      { model: 'anthropic/claude-opus-4-6', prompt: 'A cute cat', n: 1, size: '1024x1024' },
      null,
      2
    ),
    bodyNote: 'Endpoint is live. Uses "anthropic/claude-opus-4-6" model. Ensure the model is configured for image generation in your LiteLLM config.',
  },
  {
    method: 'POST',
    path: '/v1/audio/transcriptions',
    description: 'Speech-to-text — local faster-whisper models (free, runs on-device)',
    requiresAuth: true,
    defaultModel: 'local/whisper',
    curlExample: `# Multipart form-data (standard)
curl https://llm.0xmemo.com/v1/audio/transcriptions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -F "file=@audio.mp3" \\
  -F "model=local/whisper"

# JSON with base64-encoded file (Try tab format)
curl https://llm.0xmemo.com/v1/audio/transcriptions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"file":"data:audio/mp3;base64,<BASE64_DATA>","model":"local/whisper"}'`,
    defaultBody: JSON.stringify(
      {
        file: 'data:audio/mp3;base64,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',
        model: 'local/whisper',
        language: 'en',
        response_format: 'json',
      },
      null,
      2
    ),
    bodyNote: 'Includes a sample 1-second 440Hz test tone MP3 (base64). Replace the file value with your own audio. Available models: local/whisper, local/whisper-large-v3, local/whisper-large-v3-turbo, local/distil-whisper-large-v3.',
  },
  {
    method: 'POST',
    path: '/v1/audio/speech',
    description: 'Text-to-speech — requires a TTS model configured in /v1/models',
    requiresAuth: true,
    curlExample: `curl https://llm.0xmemo.com/v1/audio/speech \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "tts-1",
    "input": "Hello, world!",
    "voice": "alloy"
  }' \\
  --output speech.mp3`,
    bodyNote: 'Endpoint is live. Replace "tts-1" with a TTS model alias from /v1/models. No TTS models are currently configured by default.',
  },
  {
    method: 'GET',
    path: '/v1/balance',
    description: 'Check your API key balance and metadata',
    requiresAuth: true,
    curlExample: `curl https://llm.0xmemo.com/v1/balance \\
  -H "Authorization: Bearer YOUR_API_KEY"`,
    bodyNote: 'GET request — no body needed. Returns your current API key metadata and balance.',
  },
  {
    method: 'GET',
    path: '/v1/usage',
    description: 'Retrieve usage statistics for your API key',
    requiresAuth: true,
    curlExample: `curl https://llm.0xmemo.com/v1/usage \\
  -H "Authorization: Bearer YOUR_API_KEY"`,
    bodyNote: 'GET request — no body needed. Returns token usage and cost breakdown.',
  },
]

// ─── Claude Code Section ──────────────────────────────────────────────────────

const KEY_PLACEHOLDER = 'YOUR_API_KEY'
const SETUP_CMD_DISPLAY = `curl -fsSL https://llm.0xmemo.com/setup/claude-code.sh | LLM_GATEWAY_API_KEY="${KEY_PLACEHOLDER}" bash`

function ClaudeCodeSection({ apiKey }: { apiKey: string }) {
  const [effectiveKey, setEffectiveKey] = useState('')

  useEffect(() => {
    // Read directly from localStorage on mount + whenever apiKey prop changes
    const stored = typeof window !== 'undefined' ? localStorage.getItem('llm-gateway-api-key') : ''
    setEffectiveKey(apiKey || stored || '')
  }, [apiKey])

  return (
    <Card className="mb-8 border-l-4 border-l-violet-500">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Terminal className="h-5 w-5 text-violet-500" />
          Configure Claude Code
        </CardTitle>
        <CardDescription>
          One command sets up Claude Code to use LLM Gateway as your API provider.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* One-liner command */}
        <div className="rounded-md border bg-muted/40 p-4">
          <div className="flex items-center justify-between gap-4">
            <code className="text-xs break-all font-mono text-muted-foreground select-all">
              {SETUP_CMD_DISPLAY}
            </code>
            <div className="shrink-0">
              <CopyButton
                text={SETUP_CMD_DISPLAY}
                substitutions={effectiveKey ? { [KEY_PLACEHOLDER]: effectiveKey } : undefined}
                label="Copy"
              />
            </div>
          </div>
        </div>

        {/* API key status */}
        {effectiveKey ? (
          <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
            <Check className="h-3.5 w-3.5" />
            API key auto-filled — will be injected on copy
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Enter your API key above — it will be substituted automatically when you copy.
          </p>
        )}

        {/* What the script does */}
        <ul className="text-xs text-muted-foreground space-y-1 list-none pl-1">
          <li>• Creates <code className="text-xs">~/.claude/settings.json</code> — non-destructive merge</li>
          <li>• Sets <code className="text-xs">ANTHROPIC_BASE_URL</code> + <code className="text-xs">ANTHROPIC_AUTH_TOKEN</code></li>
          <li>• Maps model aliases: <code className="text-xs">ultra</code> / <code className="text-xs">plus</code> / <code className="text-xs">lite</code></li>
          <li>• Bypasses onboarding in <code className="text-xs">~/.claude.json</code></li>
        </ul>

        <p className="text-xs text-muted-foreground">
          Works on <strong>macOS</strong> and <strong>Linux</strong>. Requires{' '}
          <code className="text-xs">claude</code> CLI and <code className="text-xs">jq</code>{' '}
          (auto-installed if missing).
        </p>
      </CardContent>
    </Card>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function Docs() {
  const { apiKey, setApiKey } = useApiKey()
  const extendedModels = useExtendedModels()

  return (
    <div className="prose dark:prose-invert max-w-4xl mx-auto p-4 sm:p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">API Documentation</h1>
        <p className="text-muted-foreground">
          OpenAI-compatible API — add your key and start making requests
        </p>
      </div>

      {/* ── Shared API Key ── */}
      <Card className="mb-8 border-l-4 border-l-blue-500">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5 text-blue-500" />
            Your API Key
          </CardTitle>
          <CardDescription>
            Enter your key — saved in your browser's localStorage and used by the "Try" panels below
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiKeyInput apiKey={apiKey} onChange={setApiKey} />
          {!apiKey && (
            <p className="text-xs text-muted-foreground mt-2">
              Get your key from the <strong>API Keys</strong> tab. It's stored only in your browser.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Configure Claude Code ── */}
      <ClaudeCodeSection apiKey={apiKey} />

      {/* ── Available Models ── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            Available Models
          </CardTitle>
          <CardDescription>
            Live list fetched from <code>/v1/models</code> — public endpoint, no auth required.
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
            Each endpoint has a <strong>curl</strong> tab for copy-paste examples and a{' '}
            <strong>Try</strong> tab to send live requests directly from your browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {ENDPOINTS.map((ep) => (
            <EndpointTryCard
              key={ep.path + ep.description}
              method={ep.method}
              path={ep.path}
              description={ep.description}
              curlExample={ep.curlExample}
              defaultBody={'defaultBody' in ep ? ep.defaultBody : undefined}
              bodyNote={'bodyNote' in ep ? ep.bodyNote : undefined}
              apiKey={apiKey}
              requiresAuth={ep.requiresAuth}
              defaultModel={'defaultModel' in ep ? ep.defaultModel : undefined}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
