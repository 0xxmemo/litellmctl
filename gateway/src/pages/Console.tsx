import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuth } from '@/hooks/useAuth'
import { useHealth } from '@/hooks/useHealth'

type ConnState = 'connecting' | 'open' | 'closed' | 'error'

export function Console() {
  const { user } = useAuth()
  const { data: health } = useHealth()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const [state, setState] = useState<ConnState>('connecting')

  useEffect(() => {
    if (!containerRef.current) return
    if (user?.role !== 'admin') return
    if (health && !health.features.console) return

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#0b0f14' },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${wsProto}//${window.location.host}/api/admin/console`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const sendResize = () => {
      if (!fitRef.current || !termRef.current) return
      fitRef.current.fit()
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    ws.onopen = () => {
      setState('open')
      sendResize()
      term.focus()
    }
    ws.onmessage = (ev) => {
      const data: string =
        typeof ev.data === 'string'
          ? ev.data
          : new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer))
      term.write(data)
    }
    ws.onerror = () => setState('error')
    ws.onclose = () => setState('closed')

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    const ro = new ResizeObserver(() => sendResize())
    ro.observe(containerRef.current)
    window.addEventListener('resize', sendResize)

    return () => {
      window.removeEventListener('resize', sendResize)
      ro.disconnect()
      onData.dispose()
      ws.close()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      wsRef.current = null
    }
  }, [user?.role, health?.features.console])

  if (user?.role !== 'admin') {
    return (
      <div className="p-6 text-muted-foreground">
        Admin access required.
      </div>
    )
  }

  if (health && !health.features.console) {
    return (
      <div className="p-6 space-y-2">
        <h1 className="text-lg font-semibold">Console</h1>
        <p className="text-sm text-muted-foreground">
          The admin console is only available in the Docker/ECS deployment
          (<code>LITELLM_HARNESS=docker</code>). On host installs use{' '}
          <code>litellmctl</code> directly.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold">Admin Console</h1>
          <span
            className={
              'text-xs px-2 py-0.5 rounded-full ' +
              (state === 'open'
                ? 'bg-emerald-500/15 text-emerald-400'
                : state === 'connecting'
                ? 'bg-amber-500/15 text-amber-400'
                : 'bg-rose-500/15 text-rose-400')
            }
          >
            {state}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          Shell inside the container — <code>/app</code>, <code>litellmctl</code>
        </div>
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-[60vh] bg-[#0b0f14]"
      />
    </div>
  )
}
