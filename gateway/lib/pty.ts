/**
 * Admin PTY console — spawns an interactive shell inside the container and
 * exposes it over WebSocket to the gateway UI.
 *
 * Implementation notes:
 *   - We do NOT use node-pty. Both upstream node-pty and the @homebridge
 *     prebuilt fork are broken under Bun on Linux ARM64: every spawned
 *     child dies immediately with SIGHUP regardless of the command. See
 *     the commit history and ./bin/pty-proxy.py for the reproduction.
 *   - Instead we spawn `python3 bin/pty-proxy.py` via Bun.spawn with piped
 *     stdio, and use a tiny length-prefixed frame protocol over stdin to
 *     carry typed input, resize events, and a kill request.
 *
 * Gating:
 *   1. requireAdmin() at the WebSocket upgrade boundary (routes/console.ts)
 *   2. GATEWAY_CONSOLE_ENABLED !== "false"
 *   3. Re-checked per message inside attachPty / handleClientMessage
 */

import type { ServerWebSocket, Subprocess } from "bun";
import { loadUser } from "./db";

type PtyHandle = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
};

export function consoleEnabled(): boolean {
  if (process.env.GATEWAY_CONSOLE_ENABLED === "false") return false;
  return (
    process.env.GATEWAY_CONSOLE_ENABLED === "true" ||
    process.env.LITELLM_HARNESS === "docker" ||
    process.env.LITELLM_HARNESS === "ec2"
  );
}

const PROJECT_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const PROXY_SCRIPT = new URL("../bin/pty-proxy.py", import.meta.url).pathname;

/**
 * Frame builder for the Python proxy. See `bin/pty-proxy.py` for the
 * matching decoder.
 */
function frameInput(data: string): Uint8Array {
  const payload = new TextEncoder().encode(data);
  const frame = new Uint8Array(1 + 4 + payload.length);
  frame[0] = 0x44; // 'D'
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

function frameResize(cols: number, rows: number): Uint8Array {
  const frame = new Uint8Array(1 + 2 + 2);
  frame[0] = 0x52; // 'R'
  const dv = new DataView(frame.buffer);
  dv.setUint16(1, Math.max(1, cols), false);
  dv.setUint16(3, Math.max(1, rows), false);
  return frame;
}

const KILL_FRAME = new Uint8Array([0x58]); // 'X'

export function spawnConsole(cols = 80, rows = 24): PtyHandle {
  const home =
    process.env.HOME ||
    (process.env.USER ? `/home/${process.env.USER}` : "") ||
    "/root";
  const cwd = process.env.GATEWAY_DATA_DIR || PROJECT_ROOT || home || "/tmp";

  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") baseEnv[k] = v;
  }

  const env: Record<string, string> = {
    ...baseEnv,
    HOME: home,
    SHELL: "/bin/bash",
    TERM: "xterm-256color",
    LANG: baseEnv.LANG || "C.UTF-8",
    LC_ALL: baseEnv.LC_ALL || "C.UTF-8",
    PS1: baseEnv.PS1 || "\\u@\\h:\\w\\$ ",
    PTY_SHELL: "/bin/bash",
    PATH: [
      "/opt/venv/bin",
      `${PROJECT_ROOT}/venv/bin`,
      `${PROJECT_ROOT}/bin`,
      `${home}/.local/bin`,
      `${home}/.bun/bin`,
      "/root/.bun/bin",
      "/root/.local/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      baseEnv.PATH || "",
    ].filter(Boolean).join(":"),
  };

  const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn({
    cmd: ["/usr/bin/python3", "-u", PROXY_SCRIPT],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env,
  });

  // Bun's Subprocess.stdin is a FileSink — `.write()` only buffers, the
  // bytes don't leave the gateway until `.flush()` is called. For a PTY
  // where we push tiny frames (one per keystroke), we MUST flush after
  // every write or the child sees nothing until a buffer threshold is hit.
  const pushFrame = (frame: Uint8Array): void => {
    try {
      proc.stdin.write(frame);
      // flush() returns a promise; fire-and-forget, errors go to stderr log.
      const maybe = (proc.stdin as unknown as { flush?: () => unknown }).flush;
      if (typeof maybe === "function") {
        try { (maybe.call(proc.stdin) as Promise<unknown>)?.catch?.(() => {}); } catch {}
      }
    } catch {}
  };

  // Send the initial window size straight away so bash's first prompt is
  // rendered at the right width. The proxy sets a default 24x80 otherwise.
  pushFrame(frameResize(cols, rows));

  const dataSubscribers: ((d: string) => void)[] = [];
  const exitSubscribers: ((code: number) => void)[] = [];
  let exited = false;

  // Pump stdout → data subscribers.
  (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || value == null) break;
        const chunk = decoder.decode(value);
        for (const sub of dataSubscribers) {
          try { sub(chunk); } catch {}
        }
      }
    } catch (err) {
      console.error("[console][stdout]", err);
    }
  })();

  // Drain stderr to the gateway log (proxy errors, exec failures, etc).
  (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || value == null) break;
        const msg = decoder.decode(value).trimEnd();
        if (msg) console.warn("[console][proxy stderr]", msg);
      }
    } catch {}
  })();

  // Watch for exit.
  (async () => {
    const code = await proc.exited;
    exited = true;
    console.log(`[console] proxy exited code=${code}`);
    for (const sub of exitSubscribers) {
      try { sub(typeof code === "number" ? code : 1); } catch {}
    }
  })();

  return {
    write: (d) => {
      if (exited) return;
      pushFrame(frameInput(d));
    },
    resize: (c, r) => {
      if (exited) return;
      pushFrame(frameResize(c, r));
    },
    kill: () => {
      if (exited) return;
      pushFrame(KILL_FRAME);
      try { proc.kill(); } catch {}
    },
    onData: (cb) => { dataSubscribers.push(cb); },
    onExit: (cb) => { exitSubscribers.push(cb); },
  };
}

// ── WebSocket protocol ─────────────────────────────────────────────────────
// Client → server: JSON {type: "input", data} | {type: "resize", cols, rows}
// Server → client: raw terminal bytes (xterm.js writes straight to the terminal)

export interface ConsoleSocketData {
  email: string;
  pty?: PtyHandle;
}

function isStillAdmin(email: string): boolean {
  const user = loadUser(email);
  return user !== null && user.role === "admin";
}

export function attachPty(ws: ServerWebSocket<ConsoleSocketData>): void {
  if (!consoleEnabled()) {
    try { ws.close(1008, "console-disabled"); } catch {}
    return;
  }
  if (!ws.data?.email || !isStillAdmin(ws.data.email)) {
    try { ws.close(1008, "admin-required"); } catch {}
    return;
  }
  const handle = spawnConsole();
  ws.data.pty = handle;
  handle.onData((chunk) => { try { ws.send(chunk); } catch {} });
  handle.onExit((code) => {
    try { ws.send(`\r\n[process exited: ${code}]\r\n`); } catch {}
    try { ws.close(1000, "exited"); } catch {}
  });
  try { ws.send(`\r\n[admin console — user=${ws.data.email}]\r\n`); } catch {}
}

export function detachPty(ws: ServerWebSocket<ConsoleSocketData>): void {
  ws.data.pty?.kill();
  ws.data.pty = undefined;
}

export function handleClientMessage(
  ws: ServerWebSocket<ConsoleSocketData>,
  message: string | Buffer,
): void {
  const handle = ws.data.pty;
  if (!handle) return;
  if (!ws.data?.email || !isStillAdmin(ws.data.email)) {
    try { ws.close(1008, "admin-required"); } catch {}
    return;
  }
  const text = typeof message === "string" ? message : message.toString("utf8");

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { type: string; data?: string; cols?: number; rows?: number };
      if (parsed.type === "input" && typeof parsed.data === "string") {
        handle.write(parsed.data);
        return;
      }
      if (parsed.type === "resize") {
        handle.resize(parsed.cols ?? 80, parsed.rows ?? 24);
        return;
      }
    } catch {}
  }
  handle.write(text);
}
