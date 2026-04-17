# LiteLLM proxy + litellmctl (wizard, CLI). Build from repo root:
#   docker compose build
#
# ECS / Fargate image with S3 bootstrap (wizard runs in CI or locally, not in the task):
#   docker build -f docker/Dockerfile --target ecs -t litellm-proxy:ecs .
#
FROM python:3.12-slim-bookworm AS base

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/litellmctl

COPY litellm litellm
COPY bin bin
COPY templates templates
COPY .env.example .env.example

RUN python -m venv /opt/litellmctl/venv \
    && /opt/litellmctl/venv/bin/pip install --upgrade pip \
    && /opt/litellmctl/venv/bin/pip install -e "litellm[proxy]" \
    && /opt/litellmctl/venv/bin/pip install typer questionary rich

ENV PATH="/opt/litellmctl/venv/bin:/opt/litellmctl/bin:${PATH}" \
    PYTHONPATH="/opt/litellmctl/bin"

# Default data directory (override with LITELLMCTL_HOME or a volume mount)
ENV LITELLMCTL_HOME=/data

RUN mkdir -p /data/logs

VOLUME ["/data"]

# --- ECS: S3 bootstrap at task start + litellm (awscli for s3 sync) ---
FROM base AS ecs

RUN /opt/litellmctl/venv/bin/pip install --quiet awscli

COPY docker/entrypoint-ecs.sh /entrypoint-ecs.sh
RUN chmod +x /entrypoint-ecs.sh

WORKDIR /data

ENTRYPOINT ["/entrypoint-ecs.sh"]

# --- Default: same as base (Compose overrides command) ---
FROM base
