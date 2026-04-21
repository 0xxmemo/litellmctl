import {} from 'react'
import { Loader2, Cpu, Eye, Zap, Brain, Key } from 'lucide-react'
import { formatProviderName, getProviderColor } from '@lib/models'
import type { UseExtendedModelsReturn } from '@/lib/models-hooks'

export interface ModelsListProps {
  extendedModels: UseExtendedModelsReturn
}

export function ModelsList({ extendedModels }: ModelsListProps) {
  const { models, loading, error } = extendedModels

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
          return (
            <div
              key={model.id}
              className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent transition-colors"
            >
              <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {model.isStub ? (
                <span className="glass glass--muted-dim text-xs px-1.5 py-0.5 font-mono shrink-0">
                  Stub
                </span>
              ) : (
                <span className={`text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 ${colorClass}`}>
                  {formatProviderName(model.provider)}
                </span>
              )}
              <code className="text-sm font-mono truncate flex-1">{model.displayName}</code>

              {model.mode === 'embedding' &&
                (model.embeddingDimensionsOptions?.length ||
                  model.outputVectorSize != null) && (
                <span
                  className="text-xs tabular-nums text-muted-foreground shrink-0 max-w-44 truncate text-right"
                  title={
                    model.embeddingDimensionsOptions?.length
                      ? `Optional dimensions field on POST /v1/embeddings${
                          model.outputVectorSize != null
                            ? ` (deployment default ${model.outputVectorSize})`
                            : ''
                        }`
                      : model.outputVectorSize != null
                        ? 'Default vector width (model_info.output_vector_size)'
                        : undefined
                  }
                >
                  {model.embeddingDimensionsOptions?.length ? (
                    <>{model.embeddingDimensionsOptions.join(', ')}</>
                  ) : (
                    <>{model.outputVectorSize}d</>
                  )}
                </span>
              )}

              {/* Capability icons */}
              <div className="flex items-center gap-1.5 shrink-0">
                {model.supportsVision && (
                  <Eye
                    className="h-3 w-3 text-ui-info-fg"
                    aria-label="Supports vision/image input"
                  />
                )}
                {model.supportsReasoning && (
                  <Brain
                    className="h-3 w-3 text-ui-accent-fg"
                    aria-label="Supports reasoning/thinking"
                  />
                )}
                {model.supportsFunctionCalling && (
                  <Zap
                    className="h-3 w-3 text-ui-warning-fg"
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

            </div>
          )
        })}
      </div>
    </div>
  )
}
