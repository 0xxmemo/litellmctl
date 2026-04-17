#!/bin/sh
# Bootstrap /data for ECS/Fargate (no in-container wizard).
# Optional: sync from S3 when LITELLM_ECS_S3_PREFIX is set (requires task role + aws CLI in image).
set -eu

mkdir -p /data/logs
cd /data

if [ -n "${LITELLM_ECS_S3_PREFIX:-}" ]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "LITELLM_ECS_S3_PREFIX is set but aws CLI is missing; use docker build --target ecs" >&2
    exit 1
  fi
  aws s3 sync "${LITELLM_ECS_S3_PREFIX}" /data/ --region "${AWS_REGION:-us-east-1}"
fi

if [ ! -f /data/config.yaml ]; then
  echo "Missing /data/config.yaml. Use S3 sync (LITELLM_ECS_S3_PREFIX), EFS, or a bind mount." >&2
  exit 1
fi

exec litellm --config /data/config.yaml --port "${PORT:-4000}" --host 0.0.0.0
