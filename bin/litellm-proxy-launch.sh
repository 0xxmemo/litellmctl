#!/usr/bin/env bash
# Invoked by litellmctl-managed services (launchd / systemd / nohup) so proxy.log
# shows one clear line per process start (supervisor, pid, time).
set -euo pipefail
if [ "$#" -lt 1 ]; then
  echo "litellm-proxy-launch.sh: missing litellm binary path" >&2
  exit 1
fi
_bin="$1"
shift
_label="${LITELLM_SUPERVISOR:-unknown}"
_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "litellmctl: starting proxy (supervisor=${_label}, pid=$$, time=${_ts})"
exec "$_bin" "$@"
