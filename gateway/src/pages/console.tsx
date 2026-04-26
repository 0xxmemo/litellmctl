import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { RefreshCw, Eraser, Search, X, Copy, Maximize2, Minimize2, Power, AlertTriangle, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/use-auth'
import { useHealth } from '@/hooks/use-health'
import { useRestartGateway, useKillConsoleSession } from '@/hooks/use-admin'
import { Button } from '@/components/ui/button'

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
  // True from ws.onopen until the replay window closes. Replayed escape
  // sequences (DA queries like `\e[c`, status reports, OSC color queries)
  // make xterm emit responses via term.onData; if those responses reach
  // the PTY, bash's readline parses them as compound key sequences and
  // ends up displaying literal "1;2c" chars + eating the user's first
  // few keystrokes. We drop xterm-originated input during this window.
  const suppressInputRef = useRef(false)

  const [state, setState] = useState<ConnState>('connecting')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [showRestartConfirm, setShowRestartConfirm] = useState(false)
  const [showKillConfirm, setShowKillConfirm] = useState(false)
  const restartMutation = useRestartGateway()
  const killMutation = useKillConsoleSession()

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
      // Open the suppression window BEFORE the server's replay arrives.
      // 350 ms is long enough to absorb the largest replay buffer
      // (256 KiB) on a typical browser, short enough that real
      // typing-after-refresh isn't perceptibly dropped.
      suppressInputRef.current = true
      window.setTimeout(() => { suppressInputRef.current = false }, 350)
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
      // 1000 "exited" = the shell itself exited (user typed `exit` or the
      // shell crashed at startup); re-spawning immediately would either
      // surprise the user or loop forever. Require a manual Reconnect.
      const denied =
        ev.code === 1008 ||
        (ev.code === 1011 && ev.reason === 'pty-failed')
      const exited = ev.code === 1000 && ev.reason === 'exited'
      if (denied) {
        setState('denied')
        return
      }
      if (exited) {
        setState('closed')
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
    // Console-feature flag is consulted in the JSX gate below, NOT as an
    // effect dep. Including it would re-run this effect when /api/health
    // resolves (undefined → true), which disposes the freshly-built xterm
    // and opens a SECOND WebSocket — the user's keystrokes hit the dead
    // first instance and never reach the PTY.
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

    // Padding goes on term.element (not the parent container) so FitAddon's
    // row-count math subtracts it — otherwise the last row renders behind
    // the hint bar.
    if (term.element) {
      term.element.style.padding = '8px'
      term.element.style.boxSizing = 'border-box'
    }

    // WebGL renderer — fast + crisp. Silently fall back to canvas if the
    // browser / driver can't do it (happens on some Linux VMs).
    try {
      const webgl = new WebglAddon()
      term.loadAddon(webgl)
      webgl.onContextLoss(() => webgl.dispose())
    } catch {
      // canvas fallback is automatic
    }

    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    // Defer fit until the container has real dimensions — calling fit
    // synchronously right after term.open() yields 0×0 on first paint and
    // xterm renders into a collapsed viewport ("connected but invisible").
    requestAnimationFrame(() => {
      try { fit.fit() } catch {}
      // Direct refresh on /console can land before the textarea exists in
      // a focusable state; refocus once layout has settled so the user
      // can type without clicking.
      try { term.focus() } catch {}
    })

    const onData = term.onData((data) => {
      if (suppressInputRef.current) return
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment
    // at the top of this effect on why health.features.console is omitted.
  }, [user?.role, connect])

  // ── Toolbar actions ───────────────────────────────────────────────────
  // Toolbar buttons steal keyboard focus when clicked. Painful in a TUI
  // (vim, htop), where there's no "scroll back and click again" recovery.
  // Every toolbar handler returns focus to the terminal afterwards.
  const refocusTerm = useCallback(() => {
    requestAnimationFrame(() => termRef.current?.focus())
  }, [])

  const handleReconnect = useCallback(() => {
    if (reconnectTimer.current) {
      window.clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
    wsRef.current?.close()
    retryCount.current = 0
    unmountedRef.current = false
    if (termRef.current) connect(termRef.current)
    refocusTerm()
  }, [connect, refocusTerm])

  const handleClear = useCallback(() => {
    termRef.current?.clear()
    refocusTerm()
  }, [refocusTerm])

  const handleCopy = useCallback(async () => {
    const sel = termRef.current?.getSelection()
    if (sel) await navigator.clipboard.writeText(sel).catch(() => {})
    refocusTerm()
  }, [refocusTerm])

  const handleSearch = useCallback((query: string, direction: 'next' | 'prev') => {
    if (!searchRef.current) return
    if (direction === 'next') searchRef.current.findNext(query, { caseSensitive: false })
    else searchRef.current.findPrevious(query, { caseSensitive: false })
  }, [])

  const handleFullscreen = useCallback(() => {
    setFullscreen((f) => !f)
    refocusTerm()
  }, [refocusTerm])

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
          <code>node-pty</code> is built, then restart LitellmCTL.
        </p>
      </div>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────
  const statusPill =
    state === 'open'
      ? { label: 'connected', tone: 'bg-ui-success-bg text-ui-success-fg ring-ui-success-border' }
      : state === 'connecting'
      ? { label: 'connecting…', tone: 'bg-ui-warning-bg text-ui-warning-fg ring-ui-warning-border' }
      : state === 'error'
      ? { label: 'error', tone: 'bg-ui-danger-bg text-ui-danger-fg ring-ui-danger-border' }
      : state === 'denied'
      ? { label: 'access denied', tone: 'bg-ui-danger-bg text-ui-danger-fg ring-ui-danger-border' }
      : { label: 'disconnected', tone: 'bg-muted/30 text-muted-foreground ring-border/50' }

  return (
    <div
      className={
        'flex flex-col min-h-0 border border-border rounded-lg overflow-hidden bg-[#0a0a0b] ' +
        (fullscreen
          ? 'fixed inset-0 z-50 rounded-none border-0'
          : 'h-[calc(100vh-7rem)]')
      }
    >
      {/* Toolbar */}
      <div className="glass glass--muted flex items-center justify-between gap-3 border-b border-border/40 px-4 py-2 shadow-none">
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
                  ? 'bg-ui-success-fg animate-pulse'
                  : state === 'connecting'
                  ? 'bg-ui-warning-fg animate-pulse'
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
          <div className="mx-1 h-4 w-px bg-border/50" />
          <ToolbarButton
            title="Kill session — terminate the persistent shell"
            onClick={() => setShowKillConfirm(true)}
          >
            <Trash2 className="w-3.5 h-3.5 text-ui-danger-fg" />
          </ToolbarButton>
          <ToolbarButton
            title="Restart Gateway"
            onClick={() => setShowRestartConfirm(true)}
          >
            <Power className="w-3.5 h-3.5 text-ui-danger-fg" />
          </ToolbarButton>
        </div>
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div className="glass glass--muted-dim flex items-center gap-2 border-b border-border/40 px-4 py-1.5 shadow-none">
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
        onMouseDown={() => termRef.current?.focus()}
        className="flex-1 min-h-0 bg-[#0a0a0b] overflow-hidden"
      />

      {/* Hint bar */}
      {!fullscreen && (
        <div className="glass glass--muted-dim flex items-center gap-4 border-t border-border/40 px-4 py-1 text-[11px] text-muted-foreground/70 shadow-none">
          <span>
            <kbd className="px-1 rounded bg-muted text-muted-foreground">litellmctl</kbd>{' '}
            <kbd className="px-1 rounded bg-muted text-muted-foreground">claude</kbd>{' '}
            <kbd className="px-1 rounded bg-muted text-muted-foreground">caddy</kbd>{' '}
            <kbd className="px-1 rounded bg-muted text-muted-foreground">bun</kbd>{' '}
            all on $PATH
          </span>
          <span className="text-ui-success-fg/80">
            Session persists across refresh & nav — use Kill to end it
          </span>
          <span className="ml-auto">
            Right-click selects word · Shift+click extends selection · URLs are clickable
          </span>
        </div>
      )}

      {showKillConfirm && (
        <div className="glass-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="glass glass--muted w-full max-w-md rounded-xl text-card-foreground shadow-none ring-1 ring-ui-danger-border">
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="h-6 w-6 text-ui-danger-fg" />
                <h3 className="text-lg font-bold">Kill terminal session?</h3>
              </div>
              <p className="text-muted-foreground mb-4">
                This terminates the persistent shell on the server. Any
                running command in this session is killed (SIGHUP), the
                replay buffer is dropped, and the next reconnect starts a
                fresh shell.
              </p>
              <p className="text-sm text-muted-foreground mb-6">
                You don&apos;t need this to log out — refreshing or navigating
                away keeps the session running. Use Kill only when you
                actually want to end it.
              </p>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowKillConfirm(false)
                    refocusTerm()
                  }}
                  disabled={killMutation.isPending}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() =>
                    killMutation.mutate(undefined, {
                      onSuccess: ({ killed }) => {
                        toast.success(
                          killed ? 'Session terminated' : 'No active session',
                        )
                        setShowKillConfirm(false)
                        // Force a fresh reconnect so the user sees a new
                        // shell prompt (server will spawn one on attach).
                        if (reconnectTimer.current) {
                          window.clearTimeout(reconnectTimer.current)
                          reconnectTimer.current = null
                        }
                        wsRef.current?.close()
                        retryCount.current = 0
                        termRef.current?.clear()
                        if (termRef.current) connect(termRef.current)
                        refocusTerm()
                      },
                      onError: (err: unknown) => {
                        const msg = err instanceof Error ? err.message : String(err)
                        toast.error(`Kill failed: ${msg}`)
                      },
                    })
                  }
                  disabled={killMutation.isPending}
                  className="flex-1"
                >
                  {killMutation.isPending ? 'Killing…' : 'Kill session'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showRestartConfirm && (
        <div className="glass-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="glass glass--muted w-full max-w-md rounded-xl text-card-foreground shadow-none ring-1 ring-ui-danger-border">
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="h-6 w-6 text-ui-danger-fg" />
                <h3 className="text-lg font-bold">Restart Gateway?</h3>
              </div>
              <p className="text-muted-foreground mb-4">
                The gateway will stop and restart immediately. This console session,
                all open browser sessions, and any in-flight API requests will drop
                for <strong>~5&ndash;15 seconds</strong> while the frontend rebuilds
                and the service comes back up.
              </p>
              <p className="text-sm text-ui-danger-fg mb-6">
                Use this when the running gateway needs to pick up new code or
                config. The UI will reconnect automatically once the service is
                back.
              </p>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowRestartConfirm(false)
                    refocusTerm()
                  }}
                  disabled={restartMutation.isPending}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() =>
                    restartMutation.mutate(undefined, {
                      onSuccess: () => {
                        toast.success('Restart scheduled — reconnecting shortly…')
                        setShowRestartConfirm(false)
                      },
                      onError: (err: unknown) => {
                        const msg = err instanceof Error ? err.message : String(err)
                        toast.error(`Restart failed: ${msg}`)
                      },
                    })
                  }
                  disabled={restartMutation.isPending}
                  className="flex-1"
                >
                  {restartMutation.isPending ? 'Restarting…' : 'Restart'}
                </Button>
              </div>
            </div>
          </div>
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
