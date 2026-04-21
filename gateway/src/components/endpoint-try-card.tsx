import { useEffect, useState } from 'react'
import { Eye, EyeOff, Check, Key, Send, RefreshCw, Clock, Copy } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ModelSelector } from '@/components/model-selector'

const LS_KEY = 'litellmctl-api-key'
const LS_KEY_LEGACY = 'llm-gateway-api-key'

// ─── API Key hook ────────────────────────────────────────────────────────────

export function useApiKey() {
  const [apiKey, setApiKeyState] = useState('')

  useEffect(() => {
    let stored = localStorage.getItem(LS_KEY)
    if (!stored) {
      stored = localStorage.getItem(LS_KEY_LEGACY)
      if (stored) {
        localStorage.setItem(LS_KEY, stored)
        localStorage.removeItem(LS_KEY_LEGACY)
      }
    }
    if (stored) setApiKeyState(stored)
  }, [])

  const setApiKey = (val: string) => {
    setApiKeyState(val)
    localStorage.setItem(LS_KEY, val)
    try {
      localStorage.removeItem(LS_KEY_LEGACY)
    } catch {
      /* ignore */
    }
  }

  return { apiKey, setApiKey }
}

// ─── Shared API Key Input ─────────────────────────────────────────────────────

interface ApiKeyInputProps {
  apiKey: string
  onChange: (val: string) => void
}

export function ApiKeyInput({ apiKey, onChange }: ApiKeyInputProps) {
  const [show, setShow] = useState(false)

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Input
          type={show ? 'text' : 'password'}
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => onChange(e.target.value)}
          className="pr-10 font-mono text-sm"
          autoComplete="off"
        />
        <button
          type="button"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setShow((v) => !v)}
          tabIndex={-1}
          aria-label={show ? 'Hide API key' : 'Show API key'}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {apiKey && (
        <div className="flex items-center gap-1 text-ui-success-fg text-xs font-medium shrink-0">
          <Check className="h-3.5 w-3.5" />
          Saved
        </div>
      )}
    </div>
  )
}

// ─── Method badge ────────────────────────────────────────────────────────────

function MethodBadge({ method }: { method: string }) {
  const color = method === 'GET' ? 'glass glass--info' : 'glass glass--success'
  return (
    <Badge className={`${color} text-xs font-mono px-2 py-0.5 shrink-0`}>{method}</Badge>
  )
}

// ─── Status colour helper ────────────────────────────────────────────────────

function statusColor(status: number | null) {
  if (!status) return 'text-ui-danger-fg'
  if (status < 300) return 'text-ui-success-fg'
  if (status < 400) return 'text-ui-warning-fg'
  return 'text-ui-danger-fg'
}

// ─── Copy button ─────────────────────────────────────────────────────────────

/** Copies `copyText` to clipboard but displays `displayText` in the UI */
function CopyButton({ copyText }: { displayText: string; copyText: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(copyText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      title="Copy to clipboard (key replaced with placeholder)"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-ui-success-fg" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

// ─── Helper: replace "model" field in a JSON body string ─────────────────────

function replaceModelInBody(bodyStr: string, newModel: string): string {
  try {
    const parsed = JSON.parse(bodyStr)
    if (typeof parsed === 'object' && parsed !== null && 'model' in parsed) {
      parsed.model = newModel
      return JSON.stringify(parsed, null, 2)
    }
  } catch {
    // Not JSON or no model field — leave untouched
  }
  return bodyStr
}

/** Replace the model value inside a curl -d '...' or -d "{...}" snippet */
function replaceModelInCurl(curlStr: string, newModel: string): string {
  // Match "model": "value" inside the JSON string within the curl command
  return curlStr.replace(/"model"\s*:\s*"([^"]+)"/, `"model": "${newModel}"`)
}

// ─── Endpoint card with curl + Try tabs ──────────────────────────────────────

interface EndpointTryCardProps {
  method: string
  path: string
  description: string
  curlExample: string
  defaultBody?: string
  bodyNote?: string
  apiKey: string
  requiresAuth?: boolean
  /** If set, show a model selector in the Try tab with this as the default */
  defaultModel?: string
  allowedModes?: string[]
  /** For GET endpoints, whether to show query parameters input */
  hasQueryParams?: boolean
}

export function EndpointTryCard({
  method,
  path,
  description,
  curlExample,
  defaultBody,
  bodyNote,
  apiKey,
  requiresAuth = true,
  defaultModel,
  allowedModes,
  hasQueryParams = false,
}: EndpointTryCardProps) {
  // Try panel state
  const [body, setBody] = useState(defaultBody ?? '')
  const [queryParams, setQueryParams] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<{
    status: number | null
    statusText: string
    body: string
    timingMs: number | null
    error: string | null
  } | null>(null)

  const [activeCurl, setActiveCurl] = useState(curlExample)

  const handleModelChange = (model: string) => {
    setBody((prev) => replaceModelInBody(prev, model))
    setActiveCurl(replaceModelInCurl(curlExample, model))
  }

  const handleBodyChange = (raw: string) => {
    setBody(raw)
  }

  const handleSend = async () => {
    if (requiresAuth && !apiKey.trim()) {
      setResponse({
        status: null,
        statusText: '',
        body: '',
        timingMs: null,
        error: 'Enter your API key in the "Your API Key" panel above first.',
      })
      return
    }

    setLoading(true)
    setResponse(null)

    const start = performance.now()
    try {
      const headers: Record<string, string> = {}
      if (apiKey.trim()) {
        headers['Authorization'] = `Bearer ${apiKey.trim()}`
        headers['x-api-key'] = apiKey.trim()
      }
      if (method === 'POST') {
        headers['Content-Type'] = 'application/json'
      }

      const fetchPath = method === 'GET' && queryParams.trim()
        ? `${path}?${queryParams.trim()}`
        : path
      const res = await fetch(fetchPath, {
        method,
        headers,
        ...(method === 'POST' && body.trim() ? { body: body.trim() } : {}),
      })
      const timingMs = Math.round(performance.now() - start)
      const raw = await res.text()
      let text = raw
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2)
      } catch {}

      setResponse({ status: res.status, statusText: res.statusText, body: text, timingMs, error: null })
    } catch (err: any) {
      setResponse({
        status: null,
        statusText: '',
        body: '',
        timingMs: Math.round(performance.now() - start),
        error: err?.message ?? 'Network error',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 bg-muted/20 flex-wrap sm:flex-nowrap">
        <MethodBadge method={method} />
        <code className="text-sm font-mono flex-1 min-w-0">{path}</code>
        <span className="text-xs text-muted-foreground hidden md:block">{description}</span>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="curl" className="p-4">
        <TabsList className="mb-4">
          <TabsTrigger value="curl">curl</TabsTrigger>
          <TabsTrigger value="try">Try</TabsTrigger>
        </TabsList>

        {/* curl tab */}
        <TabsContent value="curl">
          {(() => {
            const displayCurl = activeCurl
            const copyCurl = apiKey
              ? activeCurl.split('YOUR_API_KEY').join(apiKey)
              : activeCurl
            return (
              <div className="relative">
                <pre className="bg-card text-foreground p-4 rounded-lg text-xs overflow-x-auto leading-relaxed pr-10">
                  {displayCurl}
                </pre>
                <CopyButton displayText={displayCurl} copyText={copyCurl} />
              </div>
            )
          })()}
        </TabsContent>

        {/* Try tab */}
        <TabsContent value="try">
          <div className="space-y-4">
            {/* Auth warning */}
            {requiresAuth && !apiKey && (
              <div className="glass glass--warning p-3 text-xs flex items-center gap-2">
                <Key className="h-4 w-4 shrink-0" />
                Enter your API key in the panel above to send authenticated requests.
              </div>
            )}

            {/* Model selector — only for POST endpoints with a defaultModel */}
            {method === 'POST' && defaultModel && (
              <ModelSelector
                endpointPath={path}
                defaultModel={defaultModel}
                onChange={handleModelChange}
                allowedModes={allowedModes}
              />
            )}

            {/* Body / query params editor */}
            {method === 'POST' ? (
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">
                  Request Body (JSON)
                </label>
                <textarea
                  className="w-full font-mono text-xs bg-card text-foreground p-3 rounded-lg border border-border resize-y min-h-[120px] focus:outline-none focus:ring-1 focus:ring-ring"
                  value={body}
                  onChange={(e) => handleBodyChange(e.target.value)}
                  spellCheck={false}
                />
                {bodyNote && (
                  <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg mt-2">
                    {bodyNote}
                  </div>
                )}
              </div>
            ) : hasQueryParams ? (
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">
                  Query Parameters
                </label>
                <Input
                  className="font-mono text-xs"
                  placeholder="q=hello&language=en"
                  value={queryParams}
                  onChange={(e) => setQueryParams(e.target.value)}
                  spellCheck={false}
                />
                {bodyNote && (
                  <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg">
                    {bodyNote}
                  </div>
                )}
              </div>
            ) : null}

            {/* Send + Clear */}
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={handleSend} disabled={loading} className="flex items-center gap-2">
                {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                {loading ? 'Sending…' : 'Send Request'}
              </Button>
              {response && (
                <button
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setResponse(null)}
                >
                  Clear
                </button>
              )}
            </div>

            {/* Response */}
            {response && (
              <div className="space-y-2">
                <div className="flex items-center gap-3 text-xs">
                  {response.status !== null ? (
                    <span className={`font-semibold ${statusColor(response.status)}`}>
                      {response.status} {response.statusText}
                    </span>
                  ) : response.error ? (
                    <span className="text-ui-danger-fg font-semibold">Error</span>
                  ) : null}
                  {response.timingMs !== null && (
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {response.timingMs} ms
                    </span>
                  )}
                </div>

                {response.error && (
                  <div className="glass glass--ui-danger p-3 text-sm">
                    {response.error}
                  </div>
                )}

                {response.body && (
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">
                      Response
                    </label>
                    {/* Image generation preview */}
                    {(() => {
                      try {
                        const parsed = JSON.parse(response.body)
                        const imageItem = parsed?.data?.[0]
                        if (imageItem && (imageItem.url || imageItem.b64_json)) {
                          const src = imageItem.url
                            ? imageItem.url
                            : `data:image/png;base64,${imageItem.b64_json}`
                          return (
                            <div className="space-y-3 mb-3">
                              <img
                                src={src}
                                alt="Generated image"
                                className="rounded-lg max-w-full border border-border"
                                style={{ maxHeight: '512px' }}
                              />
                              {imageItem.revised_prompt && (
                                <p className="text-xs text-muted-foreground italic">
                                  <span className="font-semibold not-italic text-muted-foreground">Revised prompt:</span>{' '}
                                  {imageItem.revised_prompt}
                                </p>
                              )}
                            </div>
                          )
                        }
                      } catch {
                        // not JSON or not image response — fall through to raw display
                      }
                      return null
                    })()}
                    <pre className="bg-card text-foreground p-3 rounded-lg text-xs overflow-x-auto max-h-96 overflow-y-auto">
                      {response.body}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
