import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { RefreshCw, Eraser, Search, X, Copy, Maximize2, Minimize2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useHealth } from '@/hooks/useHealth'

type ConnState = 'connecting' | 'open' | 'closed' | 'error' | 'denied'

const MAX_RETRIES = 5

// Theme mapped to the app's dark palette (tailwind slate/zinc family).
// Matching the rest of the UI so the console doesn't look bolted on.
const THEME: ITheme = {
  background: '#0a0a0b',
  foreground: '#e4e4e7',
  cursor: '#a1a1aa',
  cursorAccent: '#0a0a0b',
  selectionBackground: '#3f3f46',
  selectionForeground: '#fafafa',
  black: '#18181b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
}

export function Console() {
  const { user } = useAuth()
  const { data: health } = useHealth()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<number | null>(null)
  const retryCount = useRef(0)
  const unmountedRef = useRef(false)

  const [state, setState] = useState<ConnState>('connecting')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [fullscreen, setFullscreen] = useState(false)

  // ── Connect / reconnect logic ─────────────────────────────────────────
  const connect = useCallback((term: Terminal) => {
    setState('connecting')
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${wsProto}//${window.location.host}/api/admin/console`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const sendResize = () => {
      fitRef.current?.fit()
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    ws.onopen = () => {
      setState('open')
      retryCount.current = 0
      sendResize()
      term.focus()
    }
    ws.onmessage = (ev) => {
      const data =
        typeof ev.data === 'string'
          ? ev.data
          : new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer))
      term.write(data)
    }
    ws.onerror = () => setState('error')
    ws.onclose = (ev) => {
      wsRef.current = null
      if (unmountedRef.current) return

      // 1008 = policy violation — server denied us (non-admin, or console
      // disabled). Do NOT reconnect; that just hammers the endpoint.
      // 1011 pty-failed = node-pty unavailable on the server; same deal.
      const terminal =
        ev.code === 1008 ||
        (ev.code === 1011 && ev.reason === 'pty-failed')
      if (terminal) {
        setState('denied')
        return
      }
      setState('closed')

      // Give up after MAX_RETRIES consecutive failures rather than looping
      // forever — avoids the "connecting/disconnected" UI loop the user saw.
      if (retryCount.current >= MAX_RETRIES) return
      const attempt = retryCount.current++
      const delay = Math.min(1000 * 2 ** attempt, 15_000)
      reconnectTimer.current = window.setTimeout(() => {
        if (termRef.current && !unmountedRef.current) connect(termRef.current)
      }, delay)
    }
  }, [])

  // ── Mount: xterm + addons ─────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    if (user?.role !== 'admin') return
    if (health && !health.features.console) return

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily:
        '"JetBrains Mono", "Fira Code", "Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      letterSpacing: 0,
      theme: THEME,
      allowProposedApi: true,
      allowTransparency: false,
      convertEol: true,
      scrollback: 10_000,
      rightClickSelectsWord: true,
      macOptionIsMeta: true,
      windowsMode: false,
    })

    const fit = new FitAddon()
    const search = new SearchAddon()
    const links = new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer'))
    const clipboard = new ClipboardAddon()
    const unicode = new Unicode11Addon()

    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(links)
    term.loadAddon(clipboard)
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    term.open(containerRef.current)

    // WebGL renderer — fast + crisp. Silently fall back to canvas if the
    // browser / driver can't do it (happens on some Linux VMs).
    try {
      const webgl = new WebglAddon()
      term.loadAddon(webgl)
      webgl.onContextLoss(() => webgl.dispose())
    } catch {
      // canvas fallback is automatic
    }

    fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    const onData = term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }))
      }
    })

    connect(term)

    const sendResize = () => {
      fitRef.current?.fit()
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }
    const ro = new ResizeObserver(() => sendResize())
    ro.observe(containerRef.current)
    window.addEventListener('resize', sendResize)

    return () => {
      unmountedRef.current = true
      window.removeEventListener('resize', sendResize)
      ro.disconnect()
      onData.dispose()
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      wsRef.current = null
    }
  }, [user?.role, health?.features.console, connect])

  // ── Toolbar actions ───────────────────────────────────────────────────
  const handleReconnect = useCallback(() => {
    if (reconnectTimer.current) {
      window.clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
    wsRef.current?.close()
    retryCount.current = 0
    unmountedRef.current = false
    if (termRef.current) connect(termRef.current)
  }, [connect])

  const handleClear = useCallback(() => {
    termRef.current?.clear()
  }, [])

  const handleCopy = useCallback(async () => {
    const sel = termRef.current?.getSelection()
    if (sel) await navigator.clipboard.writeText(sel).catch(() => {})
  }, [])

  const handleSearch = useCallback((query: string, direction: 'next' | 'prev') => {
    if (!searchRef.current) return
    if (direction === 'next') searchRef.current.findNext(query, { caseSensitive: false })
    else searchRef.current.findPrevious(query, { caseSensitive: false })
  }, [])

  const handleFullscreen = useCallback(() => setFullscreen((f) => !f), [])

  // ── Gates ────────────────────────────────────────────────────────────
  if (user?.role !== 'admin') {
    return <div className="p-6 text-muted-foreground">Admin access required.</div>
  }
  if (health && !health.features.console) {
    return (
      <div className="p-6 space-y-2">
        <h1 className="text-lg font-semibold">Console</h1>
        <p className="text-sm text-muted-foreground">
          The admin console is disabled on this deployment.
          Set <code>GATEWAY_CONSOLE_ENABLED=true</code> and ensure{' '}
          <code>node-pty</code> is built, then restart the gateway.
        </p>
      </div>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────
  const statusPill =
    state === 'open'
      ? { label: 'connected', tone: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20' }
      : state === 'connecting'
      ? { label: 'connecting…', tone: 'bg-amber-500/10 text-amber-400 ring-amber-500/20' }
      : state === 'error'
      ? { label: 'error', tone: 'bg-rose-500/10 text-rose-400 ring-rose-500/20' }
      : state === 'denied'
      ? { label: 'access denied', tone: 'bg-rose-500/10 text-rose-400 ring-rose-500/20' }
      : { label: 'disconnected', tone: 'bg-zinc-500/10 text-zinc-400 ring-zinc-500/20' }

  return (
    <div
      className={
        'flex flex-col min-h-0 ' +
        (fullscreen
          ? 'fixed inset-0 z-50 bg-[#0a0a0b]'
          : 'h-full')
      }
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border bg-card/40">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-semibold tracking-tight">Admin Console</h1>
          <span
            className={
              'inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ring-1 ring-inset ' +
              statusPill.tone
            }
          >
            <span
              className={
                'w-1.5 h-1.5 rounded-full ' +
                (state === 'open'
                  ? 'bg-emerald-400 animate-pulse'
                  : state === 'connecting'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-current')
              }
            />
            {statusPill.label}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <ToolbarButton title="Search (Ctrl+F)" onClick={() => setSearchOpen((o) => !o)}>
            <Search className="w-3.5 h-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Copy selection" onClick={handleCopy}>
            <Copy className="w-3.5 h-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Clear (Ctrl+L)" onClick={handleClear}>
            <Eraser className="w-3.5 h-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Reconnect" onClick={handleReconnect}>
            <RefreshCw className="w-3.5 h-3.5" />
          </ToolbarButton>
          <ToolbarButton
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            onClick={handleFullscreen}
          >
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </ToolbarButton>
        </div>
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-card/20">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            autoFocus
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter')   handleSearch(searchQuery, e.shiftKey ? 'prev' : 'next')
              if (e.key === 'Escape')  setSearchOpen(false)
            }}
            placeholder="Find in terminal (Enter / Shift+Enter)"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <button
            onClick={() => setSearchOpen(false)}
            className="p-0.5 hover:bg-accent rounded"
            title="Close search"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Terminal */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 p-2 bg-[#0a0a0b]"
        style={{ contain: 'strict' }}
      />

      {/* Hint bar */}
      {!fullscreen && (
        <div className="px-4 py-1 text-[11px] text-muted-foreground/70 border-t border-border bg-card/20 flex items-center gap-4">
          <span>
            <kbd className="px-1 rounded bg-muted text-muted-foreground">litellmctl</kbd>{' '}
            <kbd className="px-1 rounded bg-muted text-muted-foreground">claude</kbd>{' '}
            <kbd className="px-1 rounded bg-muted text-muted-foreground">caddy</kbd>{' '}
            <kbd className="px-1 rounded bg-muted text-muted-foreground">bun</kbd>{' '}
            all on $PATH
          </span>
          <span className="ml-auto">
            Right-click selects word · Shift+click extends selection · URLs are clickable
          </span>
        </div>
      )}
    </div>
  )
}

// ── Small toolbar button ────────────────────────────────────────────────
function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
    >
      {children}
    </button>
  )
}
