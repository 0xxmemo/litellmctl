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
import { loadUser } from "./db";

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

  // When bun runs under systemd, $SHELL often points at /sbin/nologin or is
  // unset. Hard-code bash — the container/VPC always has it on $PATH.
  const shell = "/bin/bash";
  // Resolve HOME ourselves: systemd user services occasionally launch with
  // HOME unset, and `bash -l` will exit immediately if it can't find its
  // startup files. Fall back to the effective user's home.
  const home =
    process.env.HOME ||
    (process.env.USER ? `/home/${process.env.USER}` : "") ||
    "/root";
  // Prefer GATEWAY_DATA_DIR if the operator pointed us somewhere; else
  // the resolved project root; absolute last resort is $HOME then /tmp.
  const cwd = process.env.GATEWAY_DATA_DIR
    || PROJECT_ROOT
    || home
    || "/tmp";

  // Filter undefined values from process.env — node-pty chokes on them and
  // will silently exit the child (seen as "[process exited: 0]" with no
  // prompt ever appearing).
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") baseEnv[k] = v;
  }

  const env: Record<string, string> = {
    ...baseEnv,
    HOME: home,
    SHELL: shell,
    TERM: "xterm-256color",
    LANG: baseEnv.LANG || "C.UTF-8",
    LC_ALL: baseEnv.LC_ALL || "C.UTF-8",
    PS1: baseEnv.PS1 || "\\u@\\h:\\w\\$ ",
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

  // `-i -l` = interactive login shell. Without `-i`, bash that detects a
  // pipe-like stdin (some systemd/containerd configurations) runs the
  // profile and exits — which is exactly the "[process exited: 0]" bug.
  const proc = pty.spawn(shell, ["-i", "-l"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  });

  // Surface exit details in gateway logs so we can diagnose the next
  // "shell keeps dying" report without having to instrument the client.
  proc.onExit(({ exitCode, signal }) => {
    console.log(`[console] pty exited code=${exitCode} signal=${signal ?? "-"} shell=${shell} cwd=${cwd}`);
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

/**
 * Belt-and-suspenders admin check at the WebSocket boundary.
 * The HTTP upgrade already passed `requireAdmin`, but the role could
 * have been revoked in the ~ms between upgrade and `open`, and we want
 * to refuse the PTY spawn rather than leak a shell to a demoted user.
 */
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
  // Re-check admin on every message frame — cheap (cached) and ensures
  // a revoked admin cannot keep typing into a shell they opened earlier.
  if (!ws.data?.email || !isStillAdmin(ws.data.email)) {
    try { ws.close(1008, "admin-required"); } catch {}
    return;
  }
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
