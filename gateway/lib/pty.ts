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
 * Persistence:
 *   - PTY sessions are owned by the admin (keyed by email), not by the
 *     WebSocket connection. Refresh / nav / brief disconnects keep the
 *     shell running; reconnecting reattaches and replays the recent
 *     scrollback. Sessions live until the admin clicks "Kill session"
 *     (DELETE /api/admin/console) or the gateway restarts.
 *   - Multi-tab: latest WS wins. Opening a second tab kicks the first
 *     with code 1000 reason "session-moved".
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
}

function isStillAdmin(email: string): boolean {
  const user = loadUser(email);
  return user !== null && user.role === "admin";
}

// ── Per-admin session registry ─────────────────────────────────────────────
// One PTY per admin email; survives WebSocket disconnects.
//
// REPLAY_BUFFER_BYTES bounds memory for an idle session that's been writing
// output (e.g. a `tail -f`). 256 KiB ≈ one full xterm scrollback worth, big
// enough that a quick refresh sees recent context, small enough that ten
// abandoned sessions cost <3 MiB.
const REPLAY_BUFFER_BYTES = (() => {
  const v = Number(process.env.GATEWAY_CONSOLE_REPLAY_BUFFER_BYTES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 256 * 1024;
})();

interface PtySession {
  email: string;
  handle: PtyHandle;
  // Bounded scrollback for replay on reattach. Stored as encoded bytes
  // (the wire format) so replay is a single ws.send() of joined chunks.
  replay: string;
  cols: number;
  rows: number;
  attached: ServerWebSocket<ConsoleSocketData> | null;
  exited: boolean;
}

const sessions = new Map<string, PtySession>();

function appendReplay(session: PtySession, chunk: string): void {
  if (chunk.length >= REPLAY_BUFFER_BYTES) {
    // Single chunk bigger than buffer — keep only the tail.
    session.replay = chunk.slice(chunk.length - REPLAY_BUFFER_BYTES);
    return;
  }
  const combined = session.replay + chunk;
  session.replay =
    combined.length > REPLAY_BUFFER_BYTES
      ? combined.slice(combined.length - REPLAY_BUFFER_BYTES)
      : combined;
}

function disposeSession(session: PtySession, reason: string): void {
  if (sessions.get(session.email) === session) {
    sessions.delete(session.email);
  }
  if (session.attached) {
    try { session.attached.close(1000, reason); } catch {}
    session.attached = null;
  }
  if (!session.exited) {
    session.exited = true;
    try { session.handle.kill(); } catch {}
  }
}

function createSession(email: string, cols: number, rows: number): PtySession {
  const handle = spawnConsole(cols, rows);
  const session: PtySession = {
    email,
    handle,
    replay: "",
    cols,
    rows,
    attached: null,
    exited: false,
  };
  sessions.set(email, session);

  handle.onData((chunk) => {
    appendReplay(session, chunk);
    if (session.attached) {
      try { session.attached.send(chunk); } catch {}
    }
  });
  handle.onExit((code) => {
    session.exited = true;
    const banner = `\r\n[process exited: ${code}]\r\n`;
    appendReplay(session, banner);
    if (session.attached) {
      try { session.attached.send(banner); } catch {}
      try { session.attached.close(1000, "exited"); } catch {}
      session.attached = null;
    }
    sessions.delete(email);
  });
  return session;
}

/**
 * Force-terminate the active session for an admin (if any). Called by the
 * DELETE /api/admin/console route.
 */
export function killSessionForUser(email: string): boolean {
  const session = sessions.get(email);
  if (!session) return false;
  disposeSession(session, "killed");
  return true;
}

export function attachPty(ws: ServerWebSocket<ConsoleSocketData>): void {
  if (!consoleEnabled()) {
    try { ws.close(1008, "console-disabled"); } catch {}
    return;
  }
  const email = ws.data?.email;
  if (!email || !isStillAdmin(email)) {
    try { ws.close(1008, "admin-required"); } catch {}
    return;
  }

  let session = sessions.get(email);
  let resumed = false;

  if (session && !session.exited) {
    // Latest tab wins: kick whichever socket was here before.
    if (session.attached && session.attached !== ws) {
      try {
        session.attached.send("\r\n[session moved to a new tab]\r\n");
      } catch {}
      try { session.attached.close(1000, "session-moved"); } catch {}
    }
    session.attached = ws;
    resumed = true;
  } else {
    if (session?.exited) sessions.delete(email);
    session = createSession(email, 80, 24);
    session.attached = ws;
  }

  try {
    if (resumed) {
      // Replay only — no banner. Inline-rendering TUIs (Ink-based apps
      // like Claude Code, plus any program that draws into the main
      // scrollback rather than alt-screen) keep state by writing
      // relative to the current cursor position. Injecting a banner
      // below the replayed frame parks the cursor below the TUI; the
      // TUI's next redraw then clears the wrong region and stacks
      // frames. The user already knows they reopened the page — they
      // don't need a terminal-text confirmation.
      if (session.replay.length > 0) {
        ws.send(session.replay);
      }
    } else {
      ws.send(`\r\n[admin console — user=${email}]\r\n`);
    }
  } catch {}

  // Force TUIs (vim, htop, less, top, btop) running in the resumed
  // session to redraw. They redraw on SIGWINCH; SIGWINCH only fires when
  // ioctl(TIOCSWINSZ) sees changed dimensions. If the new tab happens to
  // open at the same size as the saved session, the client's resize
  // message is a no-op and the TUI sits there with stale rendering and
  // a hidden cursor (htop, less). Jiggle by 1 row and back so SIGWINCH
  // fires unconditionally; the client's own resize message lands a few
  // ms later and snaps the dimensions to the actual viewport.
  if (resumed && !session.exited) {
    const sess = session;
    setTimeout(() => {
      if (sess.exited || sess.attached !== ws) return;
      try {
        sess.handle.resize(sess.cols, Math.max(1, sess.rows - 1));
        sess.handle.resize(sess.cols, sess.rows);
      } catch {}
    }, 30);
  }
}

export function detachPty(ws: ServerWebSocket<ConsoleSocketData>): void {
  // Find the session this ws was attached to and unbind. Do NOT kill the
  // PTY — the user gets to reattach by reconnecting, and explicit kill is
  // handled by killSessionForUser via the DELETE route.
  const email = ws.data?.email;
  if (!email) return;
  const session = sessions.get(email);
  if (session && session.attached === ws) {
    session.attached = null;
  }
}

export function handleClientMessage(
  ws: ServerWebSocket<ConsoleSocketData>,
  message: string | Buffer,
): void {
  const email = ws.data?.email;
  if (!email || !isStillAdmin(email)) {
    try { ws.close(1008, "admin-required"); } catch {}
    return;
  }
  const session = sessions.get(email);
  if (!session || session.exited) return;
  // Only accept input from the currently attached socket. A stale socket
  // (post-"session-moved") shouldn't be able to type into the live shell.
  if (session.attached !== ws) return;

  const text = typeof message === "string" ? message : message.toString("utf8");

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { type: string; data?: string; cols?: number; rows?: number };
      if (parsed.type === "input" && typeof parsed.data === "string") {
        session.handle.write(parsed.data);
        return;
      }
      if (parsed.type === "resize") {
        const cols = parsed.cols ?? 80;
        const rows = parsed.rows ?? 24;
        session.cols = cols;
        session.rows = rows;
        session.handle.resize(cols, rows);
        return;
      }
    } catch {}
  }
  session.handle.write(text);
}
