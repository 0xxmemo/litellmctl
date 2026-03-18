import {} from 'react'
import { Loader2, Cpu, Eye, Zap, Brain, Key } from 'lucide-react'
import { useExtendedModels, formatProviderName, getProviderColor } from '@/lib/models'

/** Format cost per token to a readable string (e.g. $3.00/M) */
function formatCost(costPerToken: number | null): string | null {
  if (!costPerToken) return null
  const perMillion = costPerToken * 1_000_000
  return `$${perMillion.toFixed(2)}/M`
}

export function ModelsList() {
  const { models, loading, error } = useExtendedModels()

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-6">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading models…</span>
      </div>
    )
  }

  if (error) {
    return (
      <p className="text-sm text-destructive py-2">
        Failed to load models: {error}
      </p>
    )
  }

  if (models.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">No models found.</p>
  }

  return (
    <div
      className="rounded-md border"
      style={{ maxHeight: '400px', overflowY: 'auto' }}
    >
      <div className="p-2 space-y-1">
        {models.map((model) => {
          const colorClass = getProviderColor(model.provider)
          const inputCost = formatCost(model.inputCostPerToken)
          const outputCost = formatCost(model.outputCostPerToken)
          return (
            <div
              key={model.id}
              className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent transition-colors"
            >
              <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {model.isStub ? (
                <span className="text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 bg-slate-500/15 text-slate-400 border-slate-500/30">
                  Stub
                </span>
              ) : (
                <span className={`text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 ${colorClass}`}>
                  {formatProviderName(model.provider)}
                </span>
              )}
              <code className="text-sm font-mono truncate flex-1">{model.displayName}</code>

              {/* Capability icons */}
              <div className="flex items-center gap-1.5 shrink-0">
                {model.supportsVision && (
                  <Eye
                    className="h-3 w-3 text-blue-400"
                    aria-label="Supports vision/image input"
                  />
                )}
                {model.supportsReasoning && (
                  <Brain
                    className="h-3 w-3 text-violet-400"
                    aria-label="Supports reasoning/thinking"
                  />
                )}
                {model.supportsFunctionCalling && (
                  <Zap
                    className="h-3 w-3 text-yellow-400"
                    aria-label="Supports function/tool calling"
                  />
                )}
                {model.requiresApiKey && (
                  <Key
                    className="h-3 w-3 text-muted-foreground"
                    aria-label={model.apiKeyEnvVar ? `Requires ${model.apiKeyEnvVar}` : 'Requires API key'}
                  />
                )}
              </div>

              {/* Pricing */}
              {(inputCost || outputCost) && (
                <span
                  className="text-xs text-muted-foreground font-mono shrink-0 hidden lg:block"
                  title={`Input: ${inputCost ?? '?'} · Output: ${outputCost ?? '?'}`}
                >
                  {inputCost} / {outputCost}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
