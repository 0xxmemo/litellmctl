#!/usr/bin/env bash
# Auto-configures the ProtonMail SMTP bridge BEFORE the gateway longrun
# starts, so OTP emails work from the first admin login — not after a
# human-in-the-loop console session.
#
# Idempotent:
#   - No creds in env → no-op (gateway falls back to logging OTP codes).
#   - Already authenticated → no-op.
#   - Otherwise → delegates to `litellmctl auth protonmail`, which detects
#     GATEWAY_PROTON_PASSWORD and runs the non-interactive pty auth flow
#     (hydroxide_auth_auto in bin/lib/commands/protonmail.py).
#
# Never exits non-zero — we don't want a transient auth failure to block
# the whole container from starting. The gateway's email-service.ts is
# already tolerant of a missing bridge.

set -u

log() { printf '[protonmail-setup] %s\n' "$*"; }

export PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin

# Merge /data/.env so vars written by docker compose AND vars saved by
# previous hydroxide_auth_auto runs are both visible here.
if [ -f /data/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /data/.env
  set +a
fi

if [ -z "${GATEWAY_PROTON_PASSWORD:-}" ]; then
  log "GATEWAY_PROTON_PASSWORD not set — skipping ProtonMail bridge setup."
  log "Gateway will log OTP codes to stdout instead."
  exit 0
fi

HYDROXIDE_DIR="${HOME:-/root}/.config/hydroxide"
if [ -d "$HYDROXIDE_DIR" ] && [ -n "$(ls -A "$HYDROXIDE_DIR" 2>/dev/null)" ]; then
  log "hydroxide already authenticated (state in $HYDROXIDE_DIR)."
  exit 0
fi

log "authenticating hydroxide via litellmctl (non-interactive)..."
if /app/bin/litellmctl auth protonmail; then
  log "hydroxide authenticated; bridge password saved to /data/.env."
else
  log "auth flow returned non-zero — continuing anyway."
fi

exit 0
