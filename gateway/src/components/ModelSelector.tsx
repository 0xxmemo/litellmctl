import React, { useContext, useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { ChevronDown, Search, Loader2 } from 'lucide-react'
import {
  NormalizedModel,
  formatProviderName,
  getProviderColor,
  detectIsStub,
  useModels,
  getStoredModel,
  storeModel,
} from '@/lib/models'
// Lazy import via useContext to avoid circular deps — AppContext imports from lib/models, not ModelSelector
import { AppContext } from '@/context/AppContext'

// Re-export for backward compatibility
export { useModels, getStoredModel, storeModel }
export type { NormalizedModel }

/**
 * Internal hook: returns models from AppContext if available, otherwise falls
 * back to the module-level cache in lib/models.ts.
 * This prevents N redundant fetches when many selectors are mounted outside a provider.
 */
function useContextOrLocalModels() {
  const ctx = useContext(AppContext)
  const local = useModels()
  if (ctx) {
    return { models: ctx.models, loading: ctx.modelsLoading, error: ctx.modelsError }
  }
  return local
}

// ─── TierModelSelector (for Settings overrides) ───────────────────────────────

interface TierModelSelectorProps {
  /** Current override value, or undefined/null if using default alias */
  value: string | undefined | null
  /** The tier alias, e.g. "opus", "sonnet", "haiku" — shown when no override */
  defaultAlias: string
  /** Called with the new value: empty string means "use default (alias)" */
  onChange: (value: string) => void
}

export function TierModelSelector({ value, defaultAlias, onChange }: TierModelSelectorProps) {
  const { models, loading, error } = useContextOrLocalModels()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Effective display value: actual override or the alias itself
  const effectiveValue = value || defaultAlias
  const isDefault = !value

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [open])

  // Focus search when opening
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 50)
    }
  }, [open])

  const handleSelect = (modelId: string) => {
    // Empty string means "use default"
    onChange(modelId)
    setOpen(false)
    setSearch('')
  }

  // Filter + group models — search on displayName and provider
  const filtered = models.filter(
    (m) =>
      !search ||
      m.displayName.toLowerCase().includes(search.toLowerCase()) ||
      m.provider.toLowerCase().includes(search.toLowerCase()) ||
      m.owned_by.toLowerCase().includes(search.toLowerCase()),
  )

  // Group by provider label
  const groups: Record<string, NormalizedModel[]> = {}
  for (const m of filtered) {
    const key = formatProviderName(m.provider)
    if (!groups[key]) groups[key] = []
    groups[key].push(m)
  }
  const groupEntries = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))

  // Find selected model — match by id OR displayName (handles stored clean names)
  const selectedModel = models.find((m) => m.id === effectiveValue || m.displayName === effectiveValue)
  const provColorClass = selectedModel
    ? getProviderColor(selectedModel.provider)
    : getProviderColor('')

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-left hover:border-slate-500 focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
        ) : error ? (
          <span className="text-destructive text-xs">Failed to load</span>
        ) : null}

        {isDefault ? (
          <span className="text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
            default
          </span>
        ) : (
          <span className={`text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 ${provColorClass}`}>
            {selectedModel ? formatProviderName(selectedModel.provider) : '—'}
          </span>
        )}

        <span className="font-mono text-foreground flex-1 truncate">
          {selectedModel ? selectedModel.displayName : effectiveValue}
        </span>

        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[280px] max-w-[480px] rounded-md border border-slate-700 bg-slate-950 shadow-lg">
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search models…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* Model list */}
          <div className="overflow-y-auto" style={{ maxHeight: '280px' }}>
            {/* Use default option */}
            {!search && (
              <button
                type="button"
                onClick={() => handleSelect('')}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-800 transition-colors border-b border-slate-800 ${
                  isDefault ? 'bg-slate-800/60' : ''
                }`}
              >
                <span className="text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                  default
                </span>
                <span className="font-mono text-slate-200">{defaultAlias}</span>
                {isDefault && <span className="ml-auto text-green-400 text-xs shrink-0">✓</span>}
              </button>
            )}

            {groupEntries.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground text-center">No models match.</p>
            ) : (
              groupEntries.map(([provGroup, provModels]) => (
                <div key={provGroup}>
                  <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-slate-900/60 border-b border-slate-800">
                    {provGroup}
                  </div>
                  {provModels.map((m) => {
                    const isSelected = (m.id === effectiveValue || m.displayName === effectiveValue) && !isDefault
                    const stub = detectIsStub(m.id)
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => handleSelect(m.id)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-800 transition-colors ${
                          isSelected ? 'bg-slate-800/60' : ''
                        }`}
                      >
                        {stub ? (
                          <span className="text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 bg-slate-500/15 text-slate-400 border-slate-500/30">
                            Stub
                          </span>
                        ) : (
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 ${
                              getProviderColor(m.provider)
                            }`}
                          >
                            {formatProviderName(m.provider)}
                          </span>
                        )}
                        <span className="font-mono truncate text-slate-200">{m.displayName}</span>
                        {isSelected && (
                          <span className="ml-auto text-green-400 text-xs shrink-0">✓</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Component (original, for Docs Try tabs) ──────────────────────────────────

interface ModelSelectorProps {
  endpointPath: string
  defaultModel: string
  onModelChange: (model: string) => void
}

export function ModelSelector({ endpointPath, defaultModel, onModelChange }: ModelSelectorProps) {
  const { models, loading, error } = useContextOrLocalModels()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string>(() => {
    return getStoredModel(endpointPath) || defaultModel
  })
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Notify parent of initial value
  useEffect(() => {
    onModelChange(selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [open])

  // Focus search when opening
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 50)
    }
  }, [open])

  const handleSelect = (modelId: string) => {
    setSelected(modelId)
    storeModel(endpointPath, modelId)
    onModelChange(modelId)
    setOpen(false)
    setSearch('')
  }

  // Filter + group models — search on displayName and provider
  const filtered = models.filter((m) =>
    !search ||
    m.displayName.toLowerCase().includes(search.toLowerCase()) ||
    m.provider.toLowerCase().includes(search.toLowerCase()) ||
    m.owned_by.toLowerCase().includes(search.toLowerCase())
  )

  // Group by provider label
  const groups: Record<string, NormalizedModel[]> = {}
  for (const m of filtered) {
    const key = formatProviderName(m.provider)
    if (!groups[key]) groups[key] = []
    groups[key].push(m)
  }
  const groupEntries = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))

  // Find selected model — match by id OR displayName
  const selectedModel = models.find((m) => m.id === selected || m.displayName === selected)
  const provColorClass = selectedModel
    ? getProviderColor(selectedModel.provider)
    : getProviderColor('')

  return (
    <div className="relative" ref={dropdownRef}>
      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
        Model
      </label>

      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-left hover:border-slate-500 focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : error ? (
          <span className="text-destructive text-xs">Failed to load</span>
        ) : null}

        {selectedModel && detectIsStub(selectedModel.id) ? (
          <span className="text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 bg-slate-500/15 text-slate-400 border-slate-500/30">
            Stub
          </span>
        ) : (
          <span className={`text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 ${provColorClass}`}>
            {selectedModel ? formatProviderName(selectedModel.provider) : '—'}
          </span>
        )}

        <span className="font-mono text-slate-200 flex-1 truncate">
          {selectedModel ? selectedModel.displayName : selected}
        </span>

        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[280px] max-w-[480px] rounded-md border border-slate-700 bg-slate-950 shadow-lg">
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search models…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* Model list */}
          <div className="overflow-y-auto" style={{ maxHeight: '280px' }}>
            {groupEntries.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground text-center">No models match.</p>
            ) : (
              groupEntries.map(([provGroup, provModels]) => (
                <div key={provGroup}>
                  <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-slate-900/60 border-b border-slate-800">
                    {provGroup}
                  </div>
                  {provModels.map((m) => {
                    const isSelected = m.id === selected || m.displayName === selected
                    const stub = detectIsStub(m.id)
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => handleSelect(m.id)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-800 transition-colors ${
                          isSelected ? 'bg-slate-800/60' : ''
                        }`}
                      >
                        {stub ? (
                          <span className="text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 bg-slate-500/15 text-slate-400 border-slate-500/30">
                            Stub
                          </span>
                        ) : (
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 ${
                              getProviderColor(m.provider)
                            }`}
                          >
                            {formatProviderName(m.provider)}
                          </span>
                        )}
                        <span className="font-mono truncate text-slate-200">{m.displayName}</span>
                        {isSelected && (
                          <span className="ml-auto text-green-400 text-xs shrink-0">✓</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── ConfigModelSelector (for ConfigEditor dropdowns) ─────────────────────────

interface ConfigModelSelectorProps {
  /** Current selected model id / name */
  value: string
  /** Called with the new model id when selection changes */
  onChange: (value: string) => void
  /** Placeholder text when nothing selected */
  placeholder?: string
  /** Extra CSS classes for the trigger button wrapper */
  className?: string
  /**
   * Optional provider key to pre-filter the dropdown.
   * When set, only models from this provider are shown (with a "Show all" escape hatch).
   * Example: "anthropic", "openai", "google"
   */
  providerFilter?: string
  /**
   * Optional pre-fetched models list. When provided, skips the internal useModels() fetch.
   * Use this in parent components that render many selectors (e.g. FallbacksEditor) to
   * avoid N redundant API calls — fetch once in the parent, pass down to all children.
   */
  models?: NormalizedModel[]
}

/**
 * A search-enabled model dropdown for use in the ConfigEditor.
 * Fetches models from /v1/models (cached via src/lib/models.ts), groups by provider.
 * No "default alias" concept — just pick a model or leave empty.
 * Supports optional providerFilter to pre-narrow the list.
 * Supports optional models prop to skip internal fetch when parent has already fetched.
 */
export function ConfigModelSelector({
  value,
  onChange,
  placeholder = 'Select or type model…',
  className = '',
  providerFilter,
  models: modelsProp,
}: ConfigModelSelectorProps) {
  // Internal hook — uses context when available, falls back to module-level cache.
  // Must be called unconditionally (hooks rules), but we ignore its result when modelsProp exists.
  const internal = useContextOrLocalModels()
  const models = modelsProp ?? internal.models
  const loading = modelsProp ? false : internal.loading
  const error = modelsProp ? null : internal.error
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)

  // Reset showAll when dropdown closes or providerFilter changes
  useEffect(() => {
    if (!open) setShowAll(false)
  }, [open])
  useEffect(() => {
    setShowAll(false)
  }, [providerFilter])

  // Calculate dropdown position when opening
  useEffect(() => {
    if (open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setDropdownPos({
        top: rect.bottom + window.scrollY + 4,
        left: rect.left + window.scrollX,
        width: rect.width,
      })
    }
  }, [open])

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      const clickedButton = buttonRef.current?.contains(target)
      const clickedDropdown = dropdownRef.current?.contains(target)
      if (!clickedButton && !clickedDropdown) {
        setOpen(false)
        setSearch('')
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [open])

  // Focus search when opening
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 50)
    }
  }, [open])

  const handleSelect = (modelId: string) => {
    onChange(modelId)
    setOpen(false)
    setSearch('')
  }

  // Determine effective provider filter: skip if user typed a search or clicked "show all"
  const activeProviderFilter = providerFilter && !search && !showAll ? providerFilter : undefined

  // Filter models by providerFilter first, then by search query
  const filtered = models.filter((m) => {
    if (activeProviderFilter && m.provider.toLowerCase() !== activeProviderFilter.toLowerCase()) {
      return false
    }
    if (!search) return true
    return (
      m.displayName.toLowerCase().includes(search.toLowerCase()) ||
      m.provider.toLowerCase().includes(search.toLowerCase()) ||
      m.owned_by.toLowerCase().includes(search.toLowerCase())
    )
  })

  // Group by provider label
  const groups: Record<string, NormalizedModel[]> = {}
  for (const m of filtered) {
    const key = formatProviderName(m.provider)
    if (!groups[key]) groups[key] = []
    groups[key].push(m)
  }
  const groupEntries = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))

  // Count how many models are hidden by the filter
  const filteredOutCount = activeProviderFilter
    ? models.filter((m) => m.provider.toLowerCase() !== activeProviderFilter.toLowerCase()).length
    : 0

  // Find selected model — match by id OR displayName
  const selectedModel = models.find((m) => m.id === value || m.displayName === value)
  const provColorClass = selectedModel
    ? getProviderColor(selectedModel.provider)
    : getProviderColor('')

  return (
    <div className={`relative ${className}`}>
      {/* Trigger button */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-left hover:border-slate-500 focus:outline-none focus:ring-1 focus:ring-ring transition-colors h-8"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
        ) : error ? (
          <span className="text-destructive text-xs shrink-0">Failed to load</span>
        ) : null}

        {value ? (
          <>
            {selectedModel && detectIsStub(selectedModel.id) ? (
              <span className="text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 bg-slate-500/15 text-slate-400 border-slate-500/30">
                Stub
              </span>
            ) : (
              <span className={`text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 ${provColorClass}`}>
                {selectedModel ? formatProviderName(selectedModel.provider) : '—'}
              </span>
            )}
            <span className="font-mono text-foreground flex-1 truncate">
              {selectedModel ? selectedModel.displayName : value}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground flex-1 truncate">{placeholder}</span>
        )}

        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown — rendered via portal to escape overflow:hidden parents */}
      {open && dropdownPos && ReactDOM.createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[9999] min-w-[280px] max-w-[480px] rounded-md border border-slate-700 bg-slate-950 shadow-lg"
          style={{
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: Math.max(dropdownPos.width, 280),
          }}
        >
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search models…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {value && !search && (
              <button
                type="button"
                onClick={() => handleSelect('')}
                className="text-xs text-muted-foreground hover:text-foreground shrink-0 px-1"
                title="Clear selection"
              >
                ✕
              </button>
            )}
          </div>

          {/* Model list */}
          <div className="overflow-y-auto" style={{ maxHeight: '280px' }}>
            {groupEntries.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground text-center">
                {loading ? 'Loading models…' : 'No models match.'}
              </p>
            ) : (
              groupEntries.map(([provGroup, provModels]) => (
                <div key={provGroup}>
                  <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-slate-900/60 border-b border-slate-800">
                    {provGroup}
                  </div>
                  {provModels.map((m) => {
                    const isSelected = m.id === value || m.displayName === value
                    const stub = detectIsStub(m.id)
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => handleSelect(m.id)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-800 transition-colors ${
                          isSelected ? 'bg-slate-800/60' : ''
                        }`}
                      >
                        {stub ? (
                          <span className="text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 bg-slate-500/15 text-slate-400 border-slate-500/30">
                            Stub
                          </span>
                        ) : (
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 ${
                              getProviderColor(m.provider)
                            }`}
                          >
                            {formatProviderName(m.provider)}
                          </span>
                        )}
                        <span className="font-mono truncate text-slate-200">{m.displayName}</span>
                        {isSelected && (
                          <span className="ml-auto text-green-400 text-xs shrink-0">✓</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))
            )}

            {/* Show all escape hatch when provider filter is active */}
            {activeProviderFilter && filteredOutCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-slate-800/60 transition-colors border-t border-slate-800"
              >
                <span>Show all providers</span>
                <span className="text-slate-500">({filteredOutCount} more models)</span>
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
