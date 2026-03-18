#!/usr/bin/env bash
# =============================================================================
# LLM API Gateway — Bare Metal Startup Script
# Runs directly via Bun for maximum performance (no systemd/pm2 overhead).
# Includes: auto-restart, log rotation, health checks.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${SCRIPT_DIR}/logs"
LOG_FILE="${LOG_DIR}/gateway.log"
PID_FILE="${SCRIPT_DIR}/gateway.pid"
MAX_LOG_SIZE=$((50 * 1024 * 1024))   # 50MB
MAX_LOG_FILES=5
RESTART_DELAY=3
HEALTH_URL="http://localhost:${PORT:-14040}/health"
HEALTH_TIMEOUT=10

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

log() { echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] WARN${NC} $*" | tee -a "$LOG_FILE"; }
err() { echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ERROR${NC} $*" | tee -a "$LOG_FILE"; }

# ---------------------------------------------------------------------------
# Rotate logs if they get too large
# ---------------------------------------------------------------------------
rotate_logs() {
  if [[ -f "$LOG_FILE" && $(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0) -gt $MAX_LOG_SIZE ]]; then
    for i in $(seq $((MAX_LOG_FILES - 1)) -1 1); do
      [[ -f "${LOG_FILE}.$i" ]] && mv "${LOG_FILE}.$i" "${LOG_FILE}.$((i + 1))"
    done
    mv "$LOG_FILE" "${LOG_FILE}.1"
    log "Log rotated."
  fi
}

# ---------------------------------------------------------------------------
# Check if gateway is healthy
# ---------------------------------------------------------------------------
health_check() {
  curl -sf --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" > /dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Kill any existing gateway process
# ---------------------------------------------------------------------------
stop_existing() {
  if [[ -f "$PID_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$PID_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      log "Stopping existing gateway (PID $old_pid)…"
      kill "$old_pid" 2>/dev/null || true
      sleep 2
      kill -9 "$old_pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi

  # Also free the port if anything else is holding it
  local port_pid
  port_pid=$(lsof -ti :${PORT:-14040} 2>/dev/null || true)
  if [[ -n "$port_pid" ]]; then
    warn "Port ${PORT:-14040} held by PID(s): $port_pid — killing…"
    echo "$port_pid" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

# ---------------------------------------------------------------------------
# Main restart loop
# ---------------------------------------------------------------------------
run_gateway() {
  mkdir -p "$LOG_DIR"
  cd "$SCRIPT_DIR"

  log "=== LLM Gateway starting (bare metal, Bun) ==="
  log "Working dir: $SCRIPT_DIR"

  local restart_count=0
  local last_start

  while true; do
    rotate_logs
    last_start=$(date +%s)

    log "Starting Bun gateway (attempt $((restart_count + 1)))…"

    # -----------------------------------------------------------------------
    # Performance tuning env vars
    # -----------------------------------------------------------------------
    export NODE_ENV=production
    export UV_THREADPOOL_SIZE=16          # More I/O threads for MongoDB/HTTP
    export BUN_RUNTIME_TRANSPILER_CACHE_PATH="${SCRIPT_DIR}/.bun-cache"

    # Load env vars from .env if present (ensures LITELLM_MASTER_KEY etc. are set)
    if [[ -f "${SCRIPT_DIR}/.env" ]]; then
      set -a
      # shellcheck source=/dev/null
      source "${SCRIPT_DIR}/.env"
      set +a
    fi

    # -----------------------------------------------------------------------
    # Run with Bun — append stdout+stderr to log
    # -----------------------------------------------------------------------
    /home/ubuntu/.bun/bin/bun run index.js >> "$LOG_FILE" 2>&1 &
    local bun_pid=$!
    echo "$bun_pid" > "$PID_FILE"
    log "Bun PID: $bun_pid"

    # Wait briefly then health-check
    sleep 3
    if health_check; then
      log "✅ Health check passed — gateway is up."
    else
      warn "⚠️  Health check not responding yet (may still be starting)."
    fi

    # Wait for the process to exit
    wait "$bun_pid" 2>/dev/null
    local exit_code=$?

    local uptime=$(( $(date +%s) - last_start ))
    restart_count=$((restart_count + 1))
    rm -f "$PID_FILE"

    err "Gateway exited (code=$exit_code, uptime=${uptime}s). Restarting in ${RESTART_DELAY}s…"
    sleep "$RESTART_DELAY"
  done
}

# ---------------------------------------------------------------------------
# Handle signals gracefully
# ---------------------------------------------------------------------------
cleanup() {
  log "Received shutdown signal."
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    log "Stopping gateway PID $pid…"
    kill "$pid" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM

# ---------------------------------------------------------------------------
# CLI dispatch
# ---------------------------------------------------------------------------
case "${1:-start}" in
  start)
    mkdir -p "$LOG_DIR"
    stop_existing
    run_gateway
    ;;
  stop)
    stop_existing
    log "Gateway stopped."
    ;;
  restart)
    stop_existing
    sleep 1
    run_gateway
    ;;
  status)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Running (PID $(cat "$PID_FILE"))"
      health_check && echo "Health: OK" || echo "Health: FAILING"
    else
      echo "Not running"
    fi
    ;;
  logs)
    tail -f "$LOG_FILE"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
