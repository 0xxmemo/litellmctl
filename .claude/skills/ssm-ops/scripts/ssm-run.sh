#!/usr/bin/env bash
#
# ssm-run.sh — pipe a shell script on stdin, run it on the production EC2
# instance via AWS SSM, poll until done, print output, exit with the remote
# exit code.
#
# Usage:
#   ./ssm-run.sh <<'REMOTE'
#   set -eux
#   whoami
#   REMOTE
#
# Env overrides:
#   STACK_NAME    CloudFormation stack name   (default: litellm-gateway)
#   AWS_REGION    AWS region                  (default: us-east-1)
#   INSTANCE_ID   Skip CFN lookup
#   TIMEOUT_SEC   Max seconds to poll         (default: 300)
#   POLL_SEC      Polling interval seconds    (default: 3)
#
# Notes:
# - SSM runs the script as root via ssm-agent. To do work as ec2-user with
#   their systemd --user manager, wrap commands in:
#       sudo -u ec2-user -H -i bash -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) ...'
# - `litellmctl` is not on PATH in non-interactive shells — use the absolute
#   path /home/ec2-user/.litellm/bin/litellmctl.
# - SSM caps stdout/stderr at 24 KB per stream. For more, tee to a file and
#   fetch it in a follow-up invocation.

set -euo pipefail

STACK_NAME="${STACK_NAME:-litellm-gateway}"
AWS_REGION="${AWS_REGION:-us-east-1}"
TIMEOUT_SEC="${TIMEOUT_SEC:-300}"
POLL_SEC="${POLL_SEC:-3}"

if ! command -v aws >/dev/null 2>&1; then
  echo "ssm-run: aws CLI not found" >&2
  exit 127
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ssm-run: python3 required for JSON escaping" >&2
  exit 127
fi

if [ -z "${INSTANCE_ID:-}" ]; then
  INSTANCE_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
    --output text 2>/dev/null || true)
  if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
    echo "ssm-run: could not resolve InstanceId from stack '$STACK_NAME' in $AWS_REGION" >&2
    exit 1
  fi
fi

SCRIPT_TMP=$(mktemp -t ssmrun-script.XXXXXX)
PARAMS_TMP=$(mktemp -t ssmrun-params.XXXXXX.json)
trap 'rm -f "$SCRIPT_TMP" "$PARAMS_TMP"' EXIT

cat >"$SCRIPT_TMP"

if [ ! -s "$SCRIPT_TMP" ]; then
  echo "ssm-run: empty stdin — nothing to run" >&2
  exit 2
fi

# SendCommand rejects top-level `commands`; it must be wrapped under
# Parameters. Use python3 to JSON-escape the script body safely.
python3 - "$SCRIPT_TMP" >"$PARAMS_TMP" <<'PY'
import json, sys
with open(sys.argv[1]) as f: s = f.read()
print(json.dumps({"commands": [s]}))
PY

echo "ssm-run: stack=$STACK_NAME region=$AWS_REGION instance=$INSTANCE_ID" >&2

CMD_ID=$(aws ssm send-command --region "$AWS_REGION" \
  --document-name AWS-RunShellScript \
  --instance-ids "$INSTANCE_ID" \
  --parameters "file://$PARAMS_TMP" \
  --query Command.CommandId --output text)

echo "ssm-run: command-id=$CMD_ID (polling up to ${TIMEOUT_SEC}s)" >&2

deadline=$(( $(date +%s) + TIMEOUT_SEC ))
status="Pending"
while [ "$(date +%s)" -lt "$deadline" ]; do
  status=$(aws ssm get-command-invocation --region "$AWS_REGION" \
    --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo "Pending")
  case "$status" in
    Success|Failed|Cancelled|TimedOut) break ;;
  esac
  sleep "$POLL_SEC"
done

invocation=$(aws ssm get-command-invocation --region "$AWS_REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --output json)

code=$(printf '%s' "$invocation" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("ResponseCode",-1))')
stdout=$(printf '%s' "$invocation" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("StandardOutputContent",""))')
stderr=$(printf '%s' "$invocation" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("StandardErrorContent",""))')

# Print in a single stream so stdout/stderr don't interleave out of order in
# the terminal. Metadata is prefixed with `# ` to keep it greppable.
{
  echo "# status=$status response_code=$code"
  if [ -n "$stdout" ]; then
    echo "# --- stdout ---"
    printf '%s\n' "$stdout"
  fi
  if [ -n "$stderr" ]; then
    echo "# --- stderr ---"
    printf '%s\n' "$stderr"
  fi
} >&2

if [ "$status" != "Success" ]; then
  # ResponseCode may be -1 if the command never started; bubble up 1 so
  # `set -e` callers still fail.
  [ "$code" -ge 0 ] 2>/dev/null || code=1
  exit "$code"
fi
exit "$code"
