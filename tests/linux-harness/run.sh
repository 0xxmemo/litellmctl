#!/usr/bin/env bash
# Linux install-flow harness driver. Run from a Mac:
#   ./tests/linux-harness/run.sh
#
# 1. Starts the minimal Bun test gateway on 127.0.0.1:18041 (backgrounded).
# 2. Builds the Ubuntu image with bash+zsh+curl+tar+python3+jq+bun.
# 3. Runs the container; it reaches the host gateway via host.docker.internal.
# 4. The container exercises plugin and skill install flows in both bash and
#    zsh, with unquoted and quoted URLs, and inspects the final state.
# 5. Exits with the container's exit code, tears down the gateway.
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/../.." && pwd)"
PORT="${HARNESS_PORT:-18041}"
IMAGE="litellm-linux-harness:latest"

log() { echo -e "\e[36m[harness]\e[0m $*"; }

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log "stopping test gateway (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

log "starting test gateway on :$PORT"
(
  cd "$REPO_ROOT"
  HARNESS_PORT="$PORT" bun run tests/linux-harness/test-gateway.ts
) >/tmp/harness-gateway.log 2>&1 &
SERVER_PID=$!

# Wait for the server to come up.
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    log "gateway healthy"
    break
  fi
  if [ "$i" = "30" ]; then
    log "gateway failed to start — last log lines:"
    tail -30 /tmp/harness-gateway.log
    exit 1
  fi
  sleep 0.2
done

log "building docker image ($IMAGE)"
docker build --platform linux/amd64 -t "$IMAGE" "$HARNESS_DIR" >/tmp/harness-docker-build.log 2>&1 || {
  log "docker build failed — last log lines:"
  tail -30 /tmp/harness-docker-build.log
  exit 1
}

log "running container (linux/amd64)"
set +e
docker run --rm \
  --platform linux/amd64 \
  --add-host=host.docker.internal:host-gateway \
  -e HARNESS_ORIGIN="http://host.docker.internal:$PORT" \
  -e API_KEY="test-api-key-12345" \
  "$IMAGE"
RC=$?
set -e

log "container exited with rc=$RC"
exit "$RC"
