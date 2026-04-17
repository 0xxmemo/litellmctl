#!/usr/bin/env bash
# Prints one line to gateway.log per start so logs distinguish supervisor vs one-off runs.
set -euo pipefail
if [ "$#" -lt 1 ]; then
  echo "gateway-launch.sh: missing command" >&2
  exit 1
fi
_label="${GATEWAY_SUPERVISOR:-unknown}"
_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "litellmctl: starting gateway (supervisor=${_label}, pid=$$, time=${_ts})"
exec "$@"
