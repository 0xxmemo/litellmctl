#!/usr/bin/env bash
# Claude Code harness — drive the host's `claude -p` against the local
# litellm proxy on :4040. No Docker, no remote pushes. Fail loudly when the
# real Claude Code client (a) doesn't get HTTP 200, (b) sees a retry loop,
# or (c) returns empty output for the model under test.
#
# Why this matters: ~/.claude/settings.json carries env.ANTHROPIC_BASE_URL,
# and Claude Code's bootstrap (utils/managedEnv.ts:applySafeConfigEnvironmentVariables)
# Object.assigns user-settings env onto process.env AFTER shell exports —
# so plain `ANTHROPIC_BASE_URL=... claude -p` silently keeps hitting prod
# (false-positive city). We pin the test by:
#   --bare                       skip hooks, MCP, plugins, OAuth, keychain,
#                                CLAUDE.md — pure ANTHROPIC_API_KEY auth.
#   --setting-sources ""         disable user/project/local settings sources;
#                                only flagSettings + policySettings remain.
#   --settings '<inline-json>'   inject our env as the flagSettings layer,
#                                which Object.assigns last and wins.
#
# Usage:
#   ./tests/claude-harness/run.sh                              # default: kimi-code/kimi-for-coding
#   ./tests/claude-harness/run.sh codex/gpt-5.4-mini
#   PROMPT="say hi" ./tests/claude-harness/run.sh kimi-code/kimi-for-coding
#
# Reads LITELLM_MASTER_KEY from /Users/anon/.litellm/.env so it doesn't need
# to be exported in the parent shell.
set -uo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/../.." && pwd)"

PORT="${PORT:-4040}"
BASE_URL="${BASE_URL:-http://localhost:$PORT}"
MODEL="${1:-kimi-code/kimi-for-coding}"
PROMPT="${PROMPT:-hello}"
TIMEOUT_SEC="${TIMEOUT_SEC:-90}"

C_RST=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_CYN=$'\033[36m'
log()   { echo "${C_CYN}[harness]${C_RST} $*" >&2; }
ok()    { echo "${C_GRN}[ pass ]${C_RST} $*" >&2; }
fail()  { echo "${C_RED}[ FAIL ]${C_RST} $*" >&2; }
warn()  { echo "${C_YLW}[ warn ]${C_RST} $*" >&2; }

# API key resolution. Default: LITELLM_MASTER_KEY from project .env (works
# for local proxy on :4040). Override path: API_KEY=<prod-key> when pointing
# BASE_URL at a remote that doesn't accept the local master key (prod
# gateway, staging, etc.). Read from env first; fall back to .env.
MASTER_KEY="${API_KEY:-}"
if [ -z "$MASTER_KEY" ]; then
  ENV_FILE="$REPO_ROOT/.env"
  if [ ! -f "$ENV_FILE" ]; then
    fail "missing $ENV_FILE and no API_KEY set"; exit 2
  fi
  MASTER_KEY="$(grep -E '^LITELLM_MASTER_KEY=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
fi
if [ -z "${MASTER_KEY:-}" ]; then
  fail "no API key — set API_KEY=... or LITELLM_MASTER_KEY in .env"; exit 2
fi

# Sanity: target must be reachable. Try /health/readiness (litellm proxy
# direct), then a HEAD on the root (gateway + Caddy in prod). Fail fast
# with an actionable hint instead of a 90-second claude-side timeout.
PROBE_OK=0
if curl -fsS "$BASE_URL/health/readiness" >/dev/null 2>&1; then PROBE_OK=1
elif curl -fsS -o /dev/null -I --max-time 5 "$BASE_URL" 2>/dev/null; then PROBE_OK=1
elif curl -fsS -o /dev/null --max-time 5 "$BASE_URL" 2>/dev/null; then PROBE_OK=1
fi
if [ "$PROBE_OK" -eq 0 ]; then
  fail "target at $BASE_URL not reachable"
  warn "start local proxy with: $REPO_ROOT/bin/litellmctl start proxy"
  exit 2
fi

if ! command -v claude >/dev/null 2>&1; then
  fail "\`claude\` CLI not on PATH"; exit 2
fi

LOG_DIR="${TMPDIR:-/tmp}/claude-harness"
mkdir -p "$LOG_DIR"
RUN_ID="$(date +%Y%m%dT%H%M%S)-$$"
STDOUT_LOG="$LOG_DIR/$RUN_ID.stdout.log"
STDERR_LOG="$LOG_DIR/$RUN_ID.stderr.log"
DEBUG_LOG="$LOG_DIR/$RUN_ID.debug.log"

# Resolve a timeout binary. macOS doesn't ship `timeout`; coreutils brings
# `gtimeout`. Fall back to a perl alarm wrapper if neither exists.
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="$(command -v gtimeout)";
elif command -v timeout >/dev/null 2>&1;  then TIMEOUT_BIN="$(command -v timeout)";
fi

log "model:   $MODEL"
log "prompt:  $PROMPT"
log "proxy:   $BASE_URL  (port $PORT)"
log "logs:    $LOG_DIR/$RUN_ID.{stdout,stderr,debug}.log"

# Mode: "bare" (default, fast) or "full" (mirrors interactive session).
#
# bare: --bare --setting-sources "" — strips MCP, hooks, plugins,
#   CLAUDE.md, auto-memory. Smaller request, faster, isolates the
#   proxy from client-side concerns. Good for proxy-only smoke tests.
#
# full: keeps user settings (MCP servers, hooks, plugins, CLAUDE.md
#   discovery) but still injects our BASE_URL via flagSettings. Sends
#   the SAME request shape the user's interactive session sends, so it
#   catches bugs that only manifest with rich tool/system payloads
#   (e.g. cache rehydration of chunks from large prompts).
MODE="${MODE:-bare}"

# Build inline flagSettings JSON. flagSettings is a TRUSTED_SETTING_SOURCE
# in managedEnv.ts and is applied AFTER userSettings, so its env wins.
# We also clear the parent shell's ANTHROPIC_* / CLAUDE_* via `env -i` —
# belt-and-braces so any direct `process.env.X` reads (before EnvManager
# kicks in) also see our values, not the user's interactive-session vars.
SETTINGS_JSON=$(cat <<EOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "$BASE_URL",
    "ANTHROPIC_API_KEY": "$MASTER_KEY",
    "ANTHROPIC_AUTH_TOKEN": "$MASTER_KEY"
  }
}
EOF
)

# Cache busting: `claude` writes a temp settings file based on contentHash
# of the inline JSON. Identical settings → same path → no API prompt-cache
# bust. We rely on this; don't add timestamps to SETTINGS_JSON.

# Use a clean working dir so no project-scoped CLAUDE.md / .claude/ leaks
# even with --bare (defense in depth).
WORKDIR="$LOG_DIR/$RUN_ID.cwd"
mkdir -p "$WORKDIR"

START_NS=$(date +%s)
set +e
RUNNER=( )
if [ -n "$TIMEOUT_BIN" ]; then
  RUNNER=( "$TIMEOUT_BIN" "$TIMEOUT_SEC" )
else
  RUNNER=( perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$TIMEOUT_SEC" )
fi

CLAUDE_FLAGS=(
  -p "$PROMPT"
  --settings "$SETTINGS_JSON"
  --model "$MODEL"
  --debug-file "$DEBUG_LOG"
  --max-turns 1
)
if [ "$MODE" = "bare" ]; then
  CLAUDE_FLAGS+=( --bare --setting-sources "" )
fi
log "mode:    $MODE"

(
  cd "$WORKDIR" && \
  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    TERM="${TERM:-xterm-256color}" \
    "${RUNNER[@]}" \
    claude "${CLAUDE_FLAGS[@]}" \
      >"$STDOUT_LOG" 2>"$STDERR_LOG"
)
RC=$?
set -e
END_NS=$(date +%s)
ELAPSED=$((END_NS - START_NS))

log "claude exited rc=$RC in ${ELAPSED}s"

# ── assertions ───────────────────────────────────────────────────────────
FAILED=0

# 1. exit code
if [ "$RC" -ne 0 ]; then
  fail "claude exited non-zero (rc=$RC)"
  FAILED=1
else
  ok "claude exited 0"
fi

# 2. retry loop — Claude Code prints "Retrying in Ns · attempt N/10" on
#    stderr when the upstream returns garbage. Single sighting = bug.
RETRIES=$( (grep -cE 'Retrying|attempt [0-9]+/[0-9]+' "$STDERR_LOG" "$STDOUT_LOG" 2>/dev/null || true) | awk -F: '{s+=$NF} END{print s+0}')
if [ "$RETRIES" -gt 0 ]; then
  fail "detected $RETRIES retry-loop line(s) — proxy returned a malformed response"
  echo "${C_DIM}---retry context (stderr tail):${C_RST}" >&2
  tail -20 "$STDERR_LOG" | sed 's/^/  /' >&2
  FAILED=1
else
  ok "no retry-loop messages"
fi

# 3. non-empty output (catches silent-zero-content responses)
OUT_BYTES=$(wc -c < "$STDOUT_LOG" | tr -d ' ')
if [ "$OUT_BYTES" -lt 2 ]; then
  fail "claude produced empty output ($OUT_BYTES bytes)"
  FAILED=1
else
  ok "output: $OUT_BYTES bytes"
fi

# 4. no upstream-side exceptions (look for telltale 500 / Traceback /
#    StreamingChoices that proxies leak when the adapter blows up)
if grep -qE '(Invalid response object|StreamingChoices|Traceback|Internal Server Error|API Error: 500)' "$STDERR_LOG" "$STDOUT_LOG" 2>/dev/null; then
  fail "upstream error signature in claude output"
  grep -n -E '(Invalid response object|StreamingChoices|Traceback|Internal Server Error|API Error: 500)' "$STDERR_LOG" "$STDOUT_LOG" 2>/dev/null | head -5 | sed 's/^/  /' >&2
  FAILED=1
else
  ok "no upstream error signatures"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "${C_DIM}---first 200 chars of reply:${C_RST}" >&2
  head -c 200 "$STDOUT_LOG" >&2; echo >&2
  log "${C_GRN}all checks passed${C_RST}"
  exit 0
fi

echo "${C_DIM}---stdout tail:${C_RST}" >&2; tail -20 "$STDOUT_LOG" | sed 's/^/  /' >&2
echo "${C_DIM}---stderr tail:${C_RST}" >&2; tail -40 "$STDERR_LOG" | sed 's/^/  /' >&2
echo "${C_DIM}---debug tail (last 60 lines, full at $DEBUG_LOG):${C_RST}" >&2
tail -60 "$DEBUG_LOG" 2>/dev/null | sed 's/^/  /' >&2
exit 1
