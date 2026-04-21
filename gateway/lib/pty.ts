/**
 * Admin PTY console — spawns an interactive shell inside the container and
 * exposes it over WebSocket to the gateway UI. Container-only by design.
 *
 * Gating:
 *   1. LITELLM_HARNESS=docker  (set automatically by the Dockerfile)
 *   2. GATEWAY_CONSOLE_ENABLED !== "false"
 *   3. requireAdmin() session gate at the WebSocket upgrade boundary
 *
 * The PTY is backed by node-pty (native addon, works under Bun's node compat).
 * If node-pty fails to load (e.g. wrong arch), consoleEnabled() returns false
 * and the UI tab hides itself — no silent degradation.
 */

import type { ServerWebSocket } from "bun";

type PtyHandle = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
};

type PtyLib = typeof import("node-pty");
let ptyModule: PtyLib | null | undefined;

function loadPty(): PtyLib | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    // Dynamic require so a missing / broken native binding doesn't kill
    // the whole gateway at startup.
    ptyModule = require("node-pty") as PtyLib;
  } catch (err) {
    console.warn("[console] node-pty unavailable — admin console disabled:", (err as Error).message);
    ptyModule = null;
  }
  return ptyModule ?? null;
}

export function consoleEnabled(): boolean {
  // Explicit opt-out always wins.
  if (process.env.GATEWAY_CONSOLE_ENABLED === "false") return false;
  // Opt-in either by setting GATEWAY_CONSOLE_ENABLED=true OR by running
  // under a known managed harness (docker container, CFN-provisioned EC2).
  const enabled =
    process.env.GATEWAY_CONSOLE_ENABLED === "true" ||
    process.env.LITELLM_HARNESS === "docker" ||
    process.env.LITELLM_HARNESS === "ec2";
  if (!enabled) return false;
  return loadPty() !== null;
}

/**
 * Project root — the repo directory that contains `bin/`, `install.sh`,
 * `.env`, etc. The gateway process runs with cwd=<root>/gateway, so the
 * parent dir is the right place to drop the admin.
 *   Docker: /app
 *   EC2:    /home/ec2-user/.litellm
 *   Laptop: ~/.litellm
 * All of them satisfy new URL("../..", import.meta.url).
 */
const PROJECT_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

export function spawnConsole(cols = 80, rows = 24): PtyHandle {
  const pty = loadPty();
  if (!pty) throw new Error("node-pty not available");

  const shell = process.env.SHELL || "/bin/bash";
  // Prefer GATEWAY_DATA_DIR if the operator pointed us somewhere; else
  // the resolved project root; absolute last resort is $HOME then /tmp.
  const cwd = process.env.GATEWAY_DATA_DIR
    || PROJECT_ROOT
    || process.env.HOME
    || "/tmp";
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    PATH: [
      "/opt/venv/bin",
      `${PROJECT_ROOT}/venv/bin`,
      `${PROJECT_ROOT}/bin`,
      process.env.HOME ? `${process.env.HOME}/.local/bin` : "",
      process.env.HOME ? `${process.env.HOME}/.bun/bin` : "",
      "/root/.bun/bin",
      "/root/.local/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      process.env.PATH || "",
    ].filter(Boolean).join(":"),
  };

  const proc = pty.spawn(shell, ["-l"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: env as Record<string, string>,
  });

  return {
    write: (d) => proc.write(d),
    resize: (c, r) => {
      try { proc.resize(Math.max(c, 1), Math.max(r, 1)); } catch {}
    },
    kill: () => { try { proc.kill(); } catch {} },
    onData: (cb) => proc.onData(cb),
    onExit: (cb) => proc.onExit(({ exitCode }) => cb(exitCode)),
  };
}

// ── WebSocket protocol ─────────────────────────────────────────────────────
// Client → server: JSON {type: "input", data} | {type: "resize", cols, rows}
// Server → client: raw terminal bytes (xterm.js writes straight to the terminal)

export interface ConsoleSocketData {
  email: string;
  pty?: PtyHandle;
}

export function attachPty(ws: ServerWebSocket<ConsoleSocketData>): void {
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
  const text = typeof message === "string" ? message : message.toString("utf8");

  // Try JSON (control frames); any parse failure → treat as raw input.
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
