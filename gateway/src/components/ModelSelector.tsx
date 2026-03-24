import { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { ChevronDown, Search, Loader2 } from 'lucide-react'
import {
  NormalizedModel,
  type ExtendedModel,
  formatProviderName,
  getProviderColor,
  detectIsStub,
} from '@lib/models'
import {
  useExtendedModels,
  getStoredModel,
  storeModel,
  toNormalizedModels,
} from '@/lib/models-hooks'

export { getStoredModel, storeModel }
export type { NormalizedModel }

interface ModelSelectorProps {
  value?: string | null
  onChange: (value: string) => void
  models?: NormalizedModel[]
  extendedModels?: ExtendedModel[]
  placeholder?: string
  className?: string
  triggerClassName?: string
  dropdownClassName?: string
  searchInputClassName?: string
  optionTextClassName?: string
  label?: string
  providerFilter?: string
  clearable?: boolean
  defaultOption?: {
    value: string
    badge: string
    label: string
  }
  endpointPath?: string
  defaultModel?: string
  allowedModes?: string[]
}

function filterModels(
  models: NormalizedModel[],
  search: string,
  providerFilter?: string,
  allowedIds?: Set<string>,
) {
  return models.filter((m) => {
    if (allowedIds && !allowedIds.has(m.id)) {
      return false
    }
    if (providerFilter && m.provider.toLowerCase() !== providerFilter.toLowerCase()) {
      return false
    }
    if (!search) return true
    const query = search.toLowerCase()
    return (
      m.displayName.toLowerCase().includes(query) ||
      m.provider.toLowerCase().includes(query) ||
      m.owned_by.toLowerCase().includes(query) ||
      m.id.toLowerCase().includes(query)
    )
  })
}

function groupModels(models: NormalizedModel[]) {
  const groups: Record<string, NormalizedModel[]> = {}
  for (const model of models) {
    const key = formatProviderName(model.provider)
    if (!groups[key]) groups[key] = []
    groups[key].push(model)
  }
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
}

export function ModelSelector({
  value,
  onChange,
  models: modelsProp,
  extendedModels: extendedModelsProp,
  placeholder = 'Select model…',
  className = '',
  triggerClassName = 'flex items-center gap-2 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-left hover:border-slate-500 focus:outline-none focus:ring-1 focus:ring-ring transition-colors',
  dropdownClassName = 'fixed z-[9999] min-w-[280px] max-w-[480px] rounded-md border border-slate-700 bg-slate-950 shadow-lg',
  searchInputClassName = 'flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground',
  optionTextClassName = 'font-mono truncate text-slate-200 flex-1',
  label,
  providerFilter,
  clearable = false,
  defaultOption,
  endpointPath,
  defaultModel,
  allowedModes,
}: ModelSelectorProps) {
  const internal = useExtendedModels()
  const extendedModels = extendedModelsProp ?? internal.models
  const models = modelsProp ?? toNormalizedModels(extendedModels)
  const loading = modelsProp || extendedModelsProp ? false : internal.loading
  const error = modelsProp || extendedModelsProp ? null : internal.error

  const initialValue = value != null
    ? value
    : endpointPath
      ? getStoredModel(endpointPath) || defaultModel || ''
      : defaultModel || ''

  const [internalValue, setInternalValue] = useState<string>(initialValue)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const selectedValue = value != null ? value : internalValue

  useEffect(() => {
    if (value == null && endpointPath) {
      onChange(selectedValue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!open) setShowAll(false)
  }, [open])

  useEffect(() => {
    setShowAll(false)
  }, [providerFilter, allowedModes?.join('|')])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      const clickedButton = buttonRef.current?.contains(target)
      const clickedDropdown = dropdownRef.current?.contains(target)
      const clickedContainer = containerRef.current?.contains(target)
      if (!clickedButton && !clickedDropdown && !clickedContainer) {
        setOpen(false)
        setSearch('')
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 50)
    }
  }, [open])

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

  const allowedIds = useMemo(() => {
    if (!allowedModes || allowedModes.length === 0) return null
    const allowed = new Set(allowedModes.map((mode) => mode.toLowerCase()))
    return new Set(
      extendedModels
        .filter((model) => allowed.has((model.mode || '').toLowerCase()))
        .map((model) => model.id)
    )
  }, [extendedModels, allowedModes])

  const activeProviderFilter = providerFilter && !search && !showAll ? providerFilter : undefined
  const filtered = filterModels(models, search, activeProviderFilter, allowedIds ?? undefined)
  const groupEntries = groupModels(filtered)
  const filteredOutCount = activeProviderFilter
    ? models.filter((m) => {
      if (allowedIds && !allowedIds.has(m.id)) return false
      return m.provider.toLowerCase() !== activeProviderFilter.toLowerCase()
    }).length
    : 0

  const selectedModel = models.find((m) => m.id === selectedValue)
  const provColorClass = selectedModel ? getProviderColor(selectedModel.provider) : getProviderColor('')
  const isDefaultSelected = !!defaultOption && selectedValue === defaultOption.value

  const handleSelect = (modelId: string) => {
    if (value == null) {
      setInternalValue(modelId)
      if (endpointPath) storeModel(endpointPath, modelId)
    }
    onChange(modelId)
    setOpen(false)
    setSearch('')
  }

  const dropdownContent = (
    <div
      ref={dropdownRef}
      className={dropdownClassName}
      style={dropdownPos ? {
        top: dropdownPos.top,
        left: dropdownPos.left,
        width: Math.max(dropdownPos.width, 280),
      } : undefined}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          ref={searchRef}
          type="text"
          placeholder="Search models…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={searchInputClassName}
        />
        {clearable && selectedValue && !search && !defaultOption && (
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

      <div className="overflow-y-auto" style={{ maxHeight: '280px' }}>
        {defaultOption && !search && (
          <button
            type="button"
            onClick={() => handleSelect(defaultOption.value)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-800 transition-colors border-b border-slate-800 ${
              isDefaultSelected ? 'bg-slate-800/60' : ''
            }`}
          >
            <span className="text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
              {defaultOption.badge}
            </span>
            <span className={optionTextClassName}>{defaultOption.label}</span>
            {isDefaultSelected && <span className="ml-auto text-green-400 text-xs shrink-0">✓</span>}
          </button>
        )}

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
                const isSelected = !isDefaultSelected && m.id === selectedValue
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
                        className={`text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 ${getProviderColor(m.provider)}`}
                      >
                        {formatProviderName(m.provider)}
                      </span>
                    )}
                    <span className={optionTextClassName}>{m.displayName}</span>
                    {isSelected && (
                      <span className="ml-auto text-green-400 text-xs shrink-0">✓</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))
        )}

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
    </div>
  )

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      {label && (
        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
          {label}
        </label>
      )}

      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
        ) : error ? (
          <span className="text-destructive text-xs shrink-0">Failed to load</span>
        ) : null}

        {defaultOption && isDefaultSelected ? (
          <>
            <span className="text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
              {defaultOption.badge}
            </span>
            <span className={optionTextClassName}>{defaultOption.label}</span>
          </>
        ) : selectedValue ? (
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
            <span className={optionTextClassName}>{selectedModel ? selectedModel.displayName : selectedValue}</span>
          </>
        ) : (
          <span className="text-muted-foreground flex-1 truncate">{placeholder}</span>
        )}

        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && dropdownPos && ReactDOM.createPortal(dropdownContent, document.body)}
    </div>
  )
}
