/**
 * Shared script generation library — single source of truth for shell scripts.
 *
 * All generated scripts (setup, skill install/uninstall) flow through this module.
 * Uses template literals (not array joining) to produce clean, cross-platform bash
 * that works when piped via `curl ... | bash` on both macOS and Linux.
 *
 * Design:
 *  - scriptResponse()    — standard Response wrapper (Content-Type + Cache-Control)
 *  - scriptPreamble()    — shebang, set flags, utility functions
 *  - scriptValidateKey() — require an env var or exit with usage hint
 *  - scriptExpandTilde() — cross-OS ~ expansion
 *  - buildGatewayOrigin()— derive origin URL from request
 */

import { PORT } from "./config";

// ── Response helper ─────────────────────────────────────────────────────────

/**
 * Wrap a script string in a standard Response.
 * Every script endpoint MUST use this — it is the single place
 * that sets Content-Type and Cache-Control for piped-to-bash scripts.
 */
export function scriptResponse(script: string): Response {
  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

// ── Gateway origin ──────────────────────────────────────────────────────────

/**
 * Build the gateway origin URL from a request (handles proxies, ports).
 * Shared by setup and skills routes.
 */
export function buildGatewayOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = url.hostname;
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const protocol = forwardedProto || (url.protocol === "https:" ? "https" : "http");
  const port = PORT;
  return `${protocol}://${host}${protocol === "http" && port !== 443 && port !== 80 ? ":" + port : ""}`;
}

// ── Script building blocks ──────────────────────────────────────────────────
// Each returns a raw bash string. Callers embed them in template literals.

/**
 * Standard preamble: shebang + strict mode + cross-OS utility functions.
 * Every generated script starts with this.
 */
export function scriptPreamble(description: string): string {
  return `#!/usr/bin/env bash
# ${description}
#
# Cross-OS: macOS (BSD) and Linux (GNU)
#
set -euo pipefail

# --- Cross-OS utility functions ---
has_command() {
  command -v "\$1" &>/dev/null
}

ensure_dir() {
  mkdir -p "\$1"
}

copy_file() {
  local src="\$1"
  local dst="\$2"
  if [ -f "\$src" ]; then
    cp "\$src" "\$dst" && return 0
  fi
  return 1
}

sed_inplace() {
  local pattern="\$1"
  local replacement="\$2"
  local file="\$3"
  if sed --version 2>/dev/null | grep -q GNU; then
    sed -i "s|\\\${pattern}|\\\${replacement}|g" "\$file"
  else
    sed -i '' "s|\\\${pattern}|\\\${replacement}|g" "\$file"
  fi
}`;
}

/**
 * API key validation block — exits with usage hint if the variable is empty.
 */
export function scriptValidateKey(configVar: string, usageUrl: string): string {
  return `
# --- Validate API key ---
API_KEY="\${${configVar}:-}"

if [ -z "\$API_KEY" ]; then
  echo "Error: ${configVar} is not set." >&2
  echo "" >&2
  echo "Usage:" >&2
  echo "  curl -fsSL \\"${usageUrl}\\" | ${configVar}=\\"YOUR_KEY\\" bash" >&2
  exit 1
fi`;
}

/**
 * Expand tilde in a variable — works on both macOS and Linux.
 */
export function scriptExpandTilde(varName: string): string {
  return `${varName}="$(echo "\$${varName}" | sed "s|^~|\$HOME|g")"`;
}
