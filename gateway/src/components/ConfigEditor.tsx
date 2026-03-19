'use client'
import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import {
  Plus, Trash2, Save, RefreshCw, ChevronRight, Settings2, List,
  GitBranch, AlertCircle, Loader2, ArrowRight, GripVertical, RotateCcw
} from 'lucide-react'
import { toast } from 'sonner'
import { ConfigModelSelector } from './ModelSelector'
import type { NormalizedModel } from '@lib/models'
import type { UseConfigEditorReturn, ModelGroupAlias, FallbackChain, RouterSettings, ModelEntry, LiteLLMConfig } from '@/hooks/useSettings'
import type { UseModelsReturn } from '@/lib/models-hooks'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'


// ─── Tab: Fallbacks (merged: model_group_alias as Primary + fallback chains) ────

// Internal merged structure for the UI
interface MergedChain {
  id: string           // stable key (never changes, used as React key)
  alias: string        // the tier name (e.g. "opus", "sonnet")
  primary: string      // from model_group_alias[alias]
  fallbacks: string[]  // from fallbacks array for this alias
}

/** Build merged view from aliases + fallbacks arrays */
function buildMergedChains(aliases: ModelGroupAlias, fallbacks: FallbackChain[]): MergedChain[] {
  // Collect all alias keys (union of aliases and fallbacks keys)
  const allKeys = new Set([
    ...Object.keys(aliases),
    ...fallbacks.map(f => Object.keys(f)[0] || '').filter(Boolean),
  ])

  return Array.from(allKeys).map(alias => ({
    id: alias,   // stable id — alias from config is the canonical key
    alias,
    primary: aliases[alias] || '',
    fallbacks: (() => {
      const chain = fallbacks.find(f => Object.keys(f)[0] === alias)
      return chain ? (Object.values(chain)[0] as string[]) : []
    })(),
  }))
}

/** Split merged chains back into aliases + fallbacks */
function splitMergedChains(chains: MergedChain[]): { aliases: ModelGroupAlias; fallbacks: FallbackChain[] } {
  const aliases: ModelGroupAlias = {}
  const fallbacks: FallbackChain[] = []

  for (const chain of chains) {
    if (!chain.alias) continue
    if (chain.primary) aliases[chain.alias] = chain.primary
    fallbacks.push({ [chain.alias]: chain.fallbacks })
  }

  return { aliases, fallbacks }
}

// ─── Sortable model row (item within a chain: Primary or Fallback) ────────────

interface ChainSlot {
  id: string    // stable dnd key
  model: string // model value
}

function buildSlots(chain: MergedChain, chainIdx: number): ChainSlot[] {
  // Use stable chain.id (not chain.alias) so slot IDs don't change when alias is edited
  const base = chain.id || `chain-${chainIdx}`
  return [chain.primary, ...chain.fallbacks].map((model, i) => ({
    id: `${base}__slot__${i}`,
    model,
  }))
}

interface SortableSlotRowProps {
  slot: ChainSlot
  slotIndex: number   // 0 = Primary
  totalSlots: number
  allModels: NormalizedModel[]
  primaryProvider: string | undefined
  onChangeModel: (value: string) => void
  onRemove: () => void
}

function SortableSlotRow({
  slot,
  slotIndex,
  totalSlots,
  allModels,
  primaryProvider,
  onChangeModel,
  onRemove,
}: SortableSlotRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slot.id })

  const style = { transform: CSS.Transform.toString(transform), transition }
  const isPrimary = slotIndex === 0
  const label = isPrimary ? 'Primary' : `Fallback ${slotIndex}`

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 transition-all select-none ${
        isDragging
          ? 'opacity-40 bg-muted/30 ring-1 ring-primary/30'
          : 'hover:bg-muted/20'
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        className="text-muted-foreground/30 hover:text-muted-foreground/70 cursor-grab active:cursor-grabbing p-0.5 rounded flex-shrink-0 touch-none"
        title="Drag to reorder"
        type="button"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>

      <span className={`text-xs font-medium w-20 flex-shrink-0 ${isPrimary ? 'text-primary' : 'text-muted-foreground'}`}>
        {label}
      </span>

      {isPrimary
        ? <ArrowRight className="w-3.5 h-3.5 text-primary/60 flex-shrink-0" />
        : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" />
      }

      <div className="flex-1 min-w-0">
        <ConfigModelSelector
          value={slot.model}
          onChange={onChangeModel}
          placeholder={isPrimary ? 'primary model…' : 'fallback model…'}
          models={allModels}
          providerFilter={isPrimary ? undefined : primaryProvider}
        />
      </div>

      <Button
        size="sm"
        variant="ghost"
        className="text-red-500 hover:text-red-400 hover:bg-red-500/10 h-7 w-7 p-0 flex-shrink-0"
        onClick={onRemove}
        title={isPrimary ? 'Remove (next slot becomes Primary)' : 'Remove fallback'}
        disabled={totalSlots <= 1}
      >
        <Trash2 className="w-3 h-3" />
      </Button>
    </div>
  )
}

// ─── Chain card: alias header + sortable slots ────────────────────────────────

interface ChainCardProps {
  chain: MergedChain
  chainIdx: number
  allModels: NormalizedModel[]
  onCommit: (updated: MergedChain) => void
  onRemoveChain: () => void
  onUpdateAlias: (alias: string) => void
}

function ChainCard({
  chain,
  chainIdx,
  allModels,
  onCommit,
  onRemoveChain,
  onUpdateAlias,
}: ChainCardProps) {
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null)
  // Local alias state — avoids losing focus on every keystroke.
  // Parent state is only updated on blur or Enter, not on each char.
  const [localAlias, setLocalAlias] = useState(chain.alias)

  // Sync local alias when parent chain.alias changes externally (e.g. reset/refresh)
  // but only when not actively editing (use a ref to track focus)
  const aliasInputRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (document.activeElement !== aliasInputRef.current) {
      setLocalAlias(chain.alias)
    }
  }, [chain.alias])

  const slots = buildSlots(chain, chainIdx)
  const slotIds = slots.map(s => s.id)

  // Provider of whatever sits in slot 0 (Primary position) — used to filter fallback selector
  const primarySlotModel = allModels.find(
    m => m.id === slots[0]?.model || m.displayName === slots[0]?.model
  )
  const primaryProvider = primarySlotModel?.provider

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const commitSlots = (nextSlots: ChainSlot[]) => {
    const [first, ...rest] = nextSlots
    onCommit({ ...chain, primary: first?.model ?? '', fallbacks: rest.map(s => s.model) })
  }

  const handleDragStart = (e: DragStartEvent) => setActiveSlotId(String(e.active.id))

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveSlotId(null)
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = slots.findIndex(s => s.id === active.id)
    const newIdx = slots.findIndex(s => s.id === over.id)
    if (oldIdx !== -1 && newIdx !== -1) commitSlots(arrayMove(slots, oldIdx, newIdx))
  }

  const updateModel = (slotIdx: number, value: string) =>
    commitSlots(slots.map((s, i) => i === slotIdx ? { ...s, model: value } : s))

  const removeSlot = (slotIdx: number) => {
    if (slots.length <= 1) return
    commitSlots(slots.filter((_, i) => i !== slotIdx))
  }

  const addSlot = () =>
    commitSlots([...slots, { id: `${chain.id || chainIdx}__slot__${slots.length}`, model: '' }])

  const activeSlot = activeSlotId ? slots.find(s => s.id === activeSlotId) : null
  const activeSlotIdx = activeSlot ? slots.indexOf(activeSlot) : -1

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      {/* Chain header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/10">
        <Badge variant="secondary" className="font-mono text-xs flex-shrink-0">tier</Badge>
        <Input
          ref={aliasInputRef}
          value={localAlias}
          onChange={e => setLocalAlias(e.target.value)}
          onBlur={() => {
            if (localAlias !== chain.alias) onUpdateAlias(localAlias)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
          placeholder="e.g., ultra, plus, lite"
          className="h-7 text-sm font-mono w-36 flex-shrink-0"
          title="Short alias name used in API calls"
        />
        <span className="text-xs text-muted-foreground flex-1">alias name</span>
        <Button
          size="sm"
          variant="ghost"
          className="text-red-500 hover:text-red-400 hover:bg-red-500/10 h-8 w-8 p-0 flex-shrink-0"
          onClick={onRemoveChain}
          title="Remove chain"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Sortable slots */}
      <div className="px-2 py-2">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={slotIds} strategy={verticalListSortingStrategy}>
            <div className="space-y-0.5">
              {slots.map((slot, slotIdx) => (
                <SortableSlotRow
                  key={slot.id}
                  slot={slot}
                  slotIndex={slotIdx}
                  totalSlots={slots.length}
                  allModels={allModels}
                  primaryProvider={primaryProvider}
                  onChangeModel={v => updateModel(slotIdx, v)}
                  onRemove={() => removeSlot(slotIdx)}
                />
              ))}
            </div>
          </SortableContext>

          <DragOverlay dropAnimation={{ duration: 150, easing: 'ease' }}>
            {activeSlot ? (
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-card border shadow-xl ring-1 ring-primary/40 opacity-95">
                <GripVertical className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                <span className="text-xs font-medium w-20 text-primary flex-shrink-0">
                  {activeSlotIdx === 0 ? 'Primary' : `Fallback ${activeSlotIdx}`}
                </span>
                <ArrowRight className="w-3.5 h-3.5 text-primary/60 flex-shrink-0" />
                <span className="text-xs font-mono text-muted-foreground truncate">
                  {activeSlot.model || '(empty)'}
                </span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Add slot */}
      <div className="px-4 pb-3 pt-0">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-xs gap-1 text-muted-foreground hover:text-foreground"
          onClick={addSlot}
        >
          <Plus className="w-3 h-3" /> Add Fallback
        </Button>
      </div>
    </div>
  )
}

function FallbacksEditor({
  aliases,
  onAliasesChange,
  fallbacks,
  onChange,
  allModels,
}: {
  aliases: ModelGroupAlias
  onAliasesChange: (a: ModelGroupAlias) => void
  fallbacks: FallbackChain[]
  onChange: (f: FallbackChain[]) => void
  allModels: NormalizedModel[]
}) {
  const chains = buildMergedChains(aliases, fallbacks)

  const commit = (next: MergedChain[]) => {
    const { aliases: a, fallbacks: f } = splitMergedChains(next)
    onAliasesChange(a)
    onChange(f)
  }

  const addChain = () => {
    const stableId = `new-${Date.now()}`
    commit([...chains, { id: stableId, alias: '', primary: '', fallbacks: [] }])
  }

  const removeChain = (idx: number) => commit(chains.filter((_, i) => i !== idx))

  const updateAlias = (idx: number, newAlias: string) => {
    const next = [...chains]
    next[idx] = { ...next[idx], alias: newAlias }
    commit(next)
  }

  const commitChain = (idx: number, updated: MergedChain) => {
    const next = [...chains]
    next[idx] = updated
    commit(next)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <GitBranch className="w-3.5 h-3.5" /> Fallback Chains
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Each chain maps a tier alias → ordered models. Drag <GripVertical className="w-3 h-3 inline" /> within a chain to reorder — slot 1 is always Primary.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={addChain} className="gap-1.5 h-7 text-xs">
          <Plus className="w-3.5 h-3.5" /> Add Chain
        </Button>
      </div>

      {chains.length === 0 && (
        <div className="flex items-center gap-2 p-4 rounded-lg border border-dashed text-muted-foreground text-sm">
          <GitBranch className="w-4 h-4" />
          No fallback chains configured. Click "Add Chain" to create one.
        </div>
      )}

      <div className="space-y-3">
        {chains.map((chain, chainIdx) => (
          <ChainCard
            key={chain.id || `chain-${chainIdx}`}
            chain={chain}
            chainIdx={chainIdx}
            allModels={allModels}
            onCommit={updated => commitChain(chainIdx, updated)}
            onRemoveChain={() => removeChain(chainIdx)}
            onUpdateAlias={alias => updateAlias(chainIdx, alias)}
          />
        ))}
      </div>
    </div>
  )
}

const ROUTER_FIELDS: Array<{
  key: keyof RouterSettings
  label: string
  type: 'number' | 'boolean'
  description: string
  min?: number
}> = [
  {
    key: 'num_retries',
    label: 'Num Retries',
    type: 'number',
    description: 'Number of times to retry a failed request.',
    min: 0,
  },
  {
    key: 'timeout',
    label: 'Timeout (s)',
    type: 'number',
    description: 'Request timeout in seconds (blank = no limit).',
    min: 0,
  },
  {
    key: 'cooldown_time',
    label: 'Cooldown Time (s)',
    type: 'number',
    description: 'Seconds to cool down a model after consecutive failures.',
    min: 0,
  },
  {
    key: 'allowed_fails',
    label: 'Allowed Fails',
    type: 'number',
    description: 'Number of failures allowed before a model is cooled down.',
    min: 0,
  },
  {
    key: 'retry_after',
    label: 'Retry After (s)',
    type: 'number',
    description: 'Seconds to wait before retrying a cooled-down model.',
    min: 0,
  },
  {
    key: 'enable_pre_call_checks',
    label: 'Pre-Call Checks',
    type: 'boolean',
    description: 'Enable health checks before routing requests.',
  },
  {
    key: 'set_verbose',
    label: 'Verbose Logging',
    type: 'boolean',
    description: 'Enable verbose router logging for debugging.',
  },
]

function RouterSettingsEditor({
  settings,
  onChange,
}: {
  settings: RouterSettings
  onChange: (s: RouterSettings) => void
}) {
  const set = (key: keyof RouterSettings, value: number | boolean | null) => {
    onChange({ ...settings, [key]: value })
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Configure LiteLLM router behaviour — retries, timeouts, and failover settings.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {ROUTER_FIELDS.map(field => (
          <div key={field.key} className="rounded-lg border bg-card p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-sm font-medium">{field.label}</label>
              {field.type === 'boolean' ? (
                <button
                  type="button"
                  onClick={() => set(field.key, !(settings[field.key] as boolean))}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring ${
                    settings[field.key] ? 'bg-primary' : 'bg-muted-foreground/30'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                      settings[field.key] ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              ) : (
                <Input
                  type="number"
                  min={field.min ?? 0}
                  value={settings[field.key] === null || settings[field.key] === undefined ? '' : String(settings[field.key])}
                  onChange={e => {
                    const v = e.target.value
                    set(field.key, v === '' ? null : Number(v))
                  }}
                  className="text-sm h-7 w-24 text-right"
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">{field.description}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Tab: Model List ──────────────────────────────────────────────────────────

function ModelListEditor({
  modelList,
  onChange,
}: {
  modelList: ModelEntry[]
  onChange: (m: ModelEntry[]) => void
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const toggle = (idx: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const updateModelName = (idx: number, name: string) => {
    const next = [...modelList]
    next[idx] = { ...next[idx], model_name: name }
    onChange(next)
  }

  const updateLiteLLMModel = (idx: number, model: string) => {
    const next = [...modelList]
    next[idx] = { ...next[idx], litellm_params: { ...next[idx].litellm_params, model } }
    onChange(next)
  }

  const remove = (idx: number) => {
    onChange(modelList.filter((_, i) => i !== idx))
  }

  const add = () => {
    onChange([...modelList, {
      model_name: `new-model-${modelList.length + 1}`,
      litellm_params: { model: '' }
    }])
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Advanced: edit the model list directly.</p>
          <p className="text-xs text-amber-500 mt-0.5">⚠️ Changes here replace the entire model list on save.</p>
        </div>
        <Button size="sm" variant="outline" onClick={add} className="gap-1.5 h-7 text-xs">
          <Plus className="w-3.5 h-3.5" /> Add Model
        </Button>
      </div>

      {modelList.length === 0 && (
        <div className="flex items-center gap-2 p-4 rounded-lg border border-dashed text-muted-foreground text-sm">
          <List className="w-4 h-4" />
          Model list is empty or not loaded.
        </div>
      )}

      <div className="space-y-2">
        {modelList.map((entry, idx) => (
          <div key={idx} className="rounded-lg border bg-card overflow-hidden">
            <div
              className="flex items-center gap-2 p-3 cursor-pointer hover:bg-muted/30"
              onClick={() => toggle(idx)}
            >
              <ChevronRight
                className={`w-4 h-4 text-muted-foreground transition-transform ${expanded.has(idx) ? 'rotate-90' : ''}`}
              />
              <span className="font-mono text-sm font-medium flex-1">{entry.model_name || <em className="text-muted-foreground">unnamed</em>}</span>
              <Badge variant="outline" className="text-xs font-mono hidden sm:inline-flex">
                {entry.litellm_params?.model || '—'}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                className="text-red-500 hover:text-red-400 hover:bg-red-500/10 h-7 w-7 p-0"
                onClick={e => { e.stopPropagation(); remove(idx) }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>

            {expanded.has(idx) && (
              <div className="border-t px-3 py-3 space-y-3 bg-muted/10">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Model Name (alias)</label>
                    <Input
                      value={entry.model_name}
                      onChange={e => updateModelName(idx, e.target.value)}
                      className="text-sm h-8 font-mono"
                      placeholder="gpt-4o, claude-3-opus…"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">LiteLLM Model (provider)</label>
                    <Input
                      value={entry.litellm_params?.model || ''}
                      onChange={e => updateLiteLLMModel(idx, e.target.value)}
                      className="text-sm h-8 font-mono"
                      placeholder="openai/gpt-4o, anthropic/claude-3-opus-20240229…"
                    />
                  </div>
                  {entry.litellm_params?.api_base !== undefined && (
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">API Base</label>
                      <Input
                        value={String(entry.litellm_params.api_base || '')}
                        readOnly
                        className="text-sm h-8 font-mono text-muted-foreground"
                      />
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Other litellm_params (api_key, api_base, etc.) are read-only here — edit the config file directly for sensitive values.
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main ConfigEditor Component ──────────────────────────────────────────────

const DEFAULT_ROUTER_SETTINGS: RouterSettings = {
  num_retries: 3,
  timeout: null,
  cooldown_time: 60,
  allowed_fails: 3,
  retry_after: 0,
  enable_pre_call_checks: false,
  set_verbose: false,
}

interface ConfigEditorProps {
  configEditor: UseConfigEditorReturn
  models: UseModelsReturn
}

export function ConfigEditor({ configEditor, models }: ConfigEditorProps) {
  const { data: config, isLoading, error: queryError, refetch, saveMutation, resetMutation } = configEditor
  const loading = isLoading
  const allModels = models.models

  // Editable local state — seeded from query data
  const [aliases, setAliases] = useState<ModelGroupAlias>({})
  const [fallbacks, setFallbacks] = useState<FallbackChain[]>([])
  const [routerSettings, setRouterSettings] = useState<RouterSettings>(DEFAULT_ROUTER_SETTINGS)
  const [modelList, setModelList] = useState<ModelEntry[]>([])
  const [dirty, setDirty] = useState(false)
  const [seeded, setSeeded] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  // Seed local editors when config loads (only once, or on explicit refresh)
  if (config && !seeded) {
    const rs = (config.router_settings as any) || {}
    setAliases(rs.model_group_alias || config.model_group_alias || {})
    const fb = (rs.fallbacks || config.fallbacks || []) as FallbackChain[]
    setFallbacks(fb)
    const { model_group_alias: _mga, fallbacks: _fb, ...routerOnly } = rs
    setRouterSettings({ ...DEFAULT_ROUTER_SETTINGS, ...routerOnly } as RouterSettings)
    setModelList((config.model_list as ModelEntry[]) || [])
    setDirty(false)
    setSeeded(true)
  }

  const handleRefresh = () => {
    setSeeded(false) // allow re-seed after refresh
    refetch()
  }

  // Mark dirty when any editor changes
  const wrapSet = <T,>(setter: React.Dispatch<React.SetStateAction<T>>) =>
    (v: T | ((prev: T) => T)) => {
      setter(v as any)
      setDirty(true)
    }

  const handleSave = () => {
    // Strip model_info from each entry — LiteLLM's /config/update rejects
    // computed metadata fields like mode="responses" or mode="audio_transcription"
    // that it populates itself from model/info but won't accept back via the API.
    const sanitizedModelList = modelList.map(({ model_info: _mi, ...rest }) => rest)
    const patch = {
      router_settings: {
        ...routerSettings,
        model_group_alias: aliases,
        fallbacks,
      } as unknown as LiteLLMConfig['router_settings'],
      model_list: sanitizedModelList.length > 0 ? sanitizedModelList : undefined,
      update_router: true,
      save_to_file: true,
    }
    if (!patch.model_list) delete patch.model_list
    saveMutation.mutate(patch, {
      onSuccess: () => {
        setDirty(false)
        setSeeded(false) // allow re-seed on next query result
        refetch() // explicit refetch to immediately pull saved state into UI
        toast.success('Config saved ✓')
      },
      onError: (err: any) => {
        const msg = err?.message && err.message !== '[object Object]'
          ? err.message
          : JSON.stringify(err) !== '{}' ? JSON.stringify(err) : String(err)
        toast.error(`Save failed: ${msg}`)
      },
    })
  }

  const handleReset = () => {
    resetMutation.mutate(undefined, {
      onSuccess: () => {
        setSeeded(false) // re-seed from fresh query result
        setDirty(false)
        setShowResetConfirm(false)
        refetch() // explicit refetch to immediately pull reset defaults into UI
        toast.success('Config reset to YAML defaults ✓')
      },
      onError: (err: any) => {
        setShowResetConfirm(false)
        const msg = err?.message && err.message !== '[object Object]'
          ? err.message
          : JSON.stringify(err) !== '{}' ? JSON.stringify(err) : String(err)
        toast.error(`Reset failed: ${msg}`)
      },
    })
  }

  const error = queryError ? (queryError instanceof Error ? queryError.message : 'Failed to load config') : null
  const saving = saveMutation.isPending
  const resetting = resetMutation.isPending

  // ── Loading / Error states ──
  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Loading LiteLLM config…</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="border-red-500/30">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium text-red-500">Failed to load config</p>
              <p className="text-sm text-red-400 mt-1">{error}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={handleRefresh}>
                <RefreshCw className="w-4 h-4 mr-2" /> Retry
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Settings2 className="w-5 h-5" />
            LiteLLM Config Editor
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Hot-edit model aliases, fallbacks, and router settings without restarting.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {dirty && (
            <Badge variant="outline" className="text-amber-500 border-amber-500/30 bg-amber-500/10 text-xs">
              Unsaved changes
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={loading || saving || resetting}
            className="gap-1.5 h-8"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          {!showResetConfirm ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowResetConfirm(true)}
              disabled={saving || resetting}
              className="gap-1.5 h-8 text-amber-600 border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-500"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset to Defaults
            </Button>
          ) : (
            <div className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1">
              <span className="text-xs text-amber-600 font-medium">Delete DB overrides & reload YAML?</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleReset}
                disabled={resetting}
                className="h-6 px-2 text-xs text-amber-600 hover:bg-amber-500/20 gap-1"
              >
                {resetting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                {resetting ? 'Resetting…' : 'Confirm'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowResetConfirm(false)}
                disabled={resetting}
                className="h-6 px-2 text-xs text-muted-foreground hover:bg-muted/50"
              >
                Cancel
              </Button>
            </div>
          )}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !dirty || resetting}
            className="gap-1.5 h-8"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? 'Saving…' : 'Save & Reload'}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="fallbacks">
        <TabsList className="flex-wrap h-auto gap-1 mb-2">
          <TabsTrigger value="fallbacks" className="gap-1.5">
            <GitBranch className="w-3.5 h-3.5" /> Fallbacks
          </TabsTrigger>
          <TabsTrigger value="router" className="gap-1.5">
            <Settings2 className="w-3.5 h-3.5" /> Router Settings
          </TabsTrigger>
          <TabsTrigger value="models" className="gap-1.5">
            <List className="w-3.5 h-3.5" /> Model List
          </TabsTrigger>
        </TabsList>

        <Card>
          <CardContent className="pt-4 pb-4">
            <TabsContent value="fallbacks">
              <FallbacksEditor
                aliases={aliases}
                onAliasesChange={wrapSet(setAliases)}
                fallbacks={fallbacks}
                onChange={wrapSet(setFallbacks)}
                allModels={allModels}
              />
            </TabsContent>

            <TabsContent value="router">
              <RouterSettingsEditor
                settings={routerSettings}
                onChange={wrapSet(setRouterSettings)}
              />
            </TabsContent>

            <TabsContent value="models">
              <ModelListEditor
                modelList={modelList}
                onChange={wrapSet(setModelList)}
              />
            </TabsContent>
          </CardContent>
        </Card>
      </Tabs>

      {/* Raw config preview */}
      {config && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 select-none list-none">
            <ChevronRight className="w-3.5 h-3.5 transition-transform group-open:rotate-90" />
            View raw config (read-only)
          </summary>
          <pre className="mt-2 p-3 rounded-lg border bg-muted/50 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto text-muted-foreground">
            {JSON.stringify(config, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}
