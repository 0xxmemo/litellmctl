# syntax=docker/dockerfile:1.7
#
# LiteLLM Gateway — primary container image (ARM64 / Graviton).
#
# Contains ONLY the core services:
#   - litellm proxy          (:4040, internal)
#   - bun gateway UI + API   (:14041, fronted by Caddy)
#   - Caddy reverse proxy    (:80 + :443, auto-TLS when a domain is set)
#
# Sidecars (Ollama, SearXNG, faster-whisper) ship as public images and are
# wired in via docker/compose.yml so they can be pulled in parallel on the
# EC2 host. See docs/docker.md.
#
# Build:   docker build --platform linux/arm64 -t litellm-gw:dev .
# Run:     docker compose -f docker/compose.yml up -d

ARG PYTHON_VERSION=3.12
ARG BUN_VERSION=1.3.9
ARG S6_OVERLAY_VERSION=3.2.0.2
ARG CADDY_VERSION=2.8.4
# "latest" | "stable" | an explicit version like "2.1.89"
ARG CLAUDE_CODE_CHANNEL=latest

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: builder — install Python deps, bun, build gateway frontend
# ──────────────────────────────────────────────────────────────────────────────
FROM --platform=linux/arm64 python:${PYTHON_VERSION}-slim-bookworm AS builder
ARG BUN_VERSION

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/root/.bun/bin:/opt/venv/bin:$PATH \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates unzip xz-utils \
      build-essential pkg-config python3-dev \
      libsqlite3-dev libssl-dev libffi-dev \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --upgrade pip wheel setuptools

WORKDIR /app

COPY litellm/ /app/litellm/
RUN pip install -e "/app/litellm[proxy]"

# Gateway — install deps, build frontend (node-pty builds a native binding here)
COPY gateway/package.json gateway/bun.lock /app/gateway/
WORKDIR /app/gateway
RUN bun install --frozen-lockfile

COPY gateway/ /app/gateway/
RUN bun run build

# Remaining repo bits the runtime needs
WORKDIR /app
COPY bin/ /app/bin/
COPY templates/ /app/templates/
COPY plugins/ /app/plugins/
COPY .env.example /app/.env.example

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: runtime — minimal image, s6-overlay + Caddy + venv + bun
# ──────────────────────────────────────────────────────────────────────────────
FROM --platform=linux/arm64 python:${PYTHON_VERSION}-slim-bookworm AS runtime
ARG S6_OVERLAY_VERSION
ARG CADDY_VERSION

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/root/.bun/bin:/opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LITELLM_HARNESS=docker \
    LITELLM_LOCAL_MODEL_COST_MAP=true \
    GATEWAY_DATA_DIR=/data \
    GATEWAY_PORT=14041 \
    S6_KEEP_ENV=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=30000

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates xz-utils tini procps bash less git \
      libsqlite3-0 libstdc++6 libgomp1 libgcc-s1 \
 && rm -rf /var/lib/apt/lists/*

# ── Claude Code CLI ──────────────────────────────────────────────────────────
# Ships as a native per-platform binary — no Node runtime required. The
# installer script drops `claude` in /root/.local/bin and keeps versioned
# binaries under /root/.local/share/claude. Both of those dirs are
# persisted under /data/home by the entrypoint, so the background
# auto-updater writes to the data volume and survives container rebuilds.
ARG CLAUDE_CODE_CHANNEL
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh \
 && bash /tmp/claude-install.sh "${CLAUDE_CODE_CHANNEL}" \
 && rm /tmp/claude-install.sh \
 && /root/.local/bin/claude --version

# ── s6-overlay v3 (supervisor) ───────────────────────────────────────────────
RUN curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" -o /tmp/s6-noarch.tar.xz \
 && tar -C / -Jxpf /tmp/s6-noarch.tar.xz \
 && curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-aarch64.tar.xz" -o /tmp/s6-arch.tar.xz \
 && tar -C / -Jxpf /tmp/s6-arch.tar.xz \
 && rm /tmp/s6-*.tar.xz

# ── Caddy (static arm64 binary) ──────────────────────────────────────────────
RUN curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_arm64.tar.gz" \
      | tar -C /usr/local/bin -xz caddy \
 && chmod +x /usr/local/bin/caddy \
 && caddy version

# ── Copy build artifacts ─────────────────────────────────────────────────────
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /root/.bun /root/.bun
COPY --from=builder /app /app

# Entrypoint (kept as a file for easy auditing/editing)
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh \
 && chmod +x /app/bin/litellmctl \
             /app/bin/gateway-launch.sh \
             /app/bin/litellm-proxy-launch.sh

# ── s6 service tree (inlined so the repo tree stays clean) ───────────────────
# Three longrun services (proxy, gateway, caddy) + one oneshot (init-data).
# Dependency chain:  init-data → litellm-proxy → gateway → caddy
# Heredocs below require BuildKit (enabled by the # syntax= directive above).

RUN <<'SH'
set -eux
for svc in litellm-proxy gateway caddy init-data; do
  mkdir -p "/etc/s6-overlay/s6-rc.d/${svc}"
  mkdir -p "/etc/s6-overlay/s6-rc.d/${svc}/dependencies.d"
done
mkdir -p /etc/s6-overlay/s6-rc.d/user/contents.d
for svc in litellm-proxy gateway caddy init-data; do
  : > "/etc/s6-overlay/s6-rc.d/user/contents.d/${svc}"
done

# init-data — oneshot, runs once before longruns. Delegates to the entrypoint
# which already knows how to seed /data; calling it twice is safe (idempotent).
echo oneshot > /etc/s6-overlay/s6-rc.d/init-data/type
printf '/app/docker/entrypoint.sh\n' > /etc/s6-overlay/s6-rc.d/init-data/up

# litellm-proxy — :4040, internal
echo longrun > /etc/s6-overlay/s6-rc.d/litellm-proxy/type
: > /etc/s6-overlay/s6-rc.d/litellm-proxy/dependencies.d/init-data

# gateway — :14041, fronted by Caddy
echo longrun > /etc/s6-overlay/s6-rc.d/gateway/type
: > /etc/s6-overlay/s6-rc.d/gateway/dependencies.d/litellm-proxy

# caddy — :80 + :443, reverse proxy to gateway
echo longrun > /etc/s6-overlay/s6-rc.d/caddy/type
: > /etc/s6-overlay/s6-rc.d/caddy/dependencies.d/gateway
SH

RUN <<'SH'
cat > /etc/s6-overlay/s6-rc.d/litellm-proxy/run <<'RUN'
#!/command/with-contenv bash
set -euo pipefail
export PATH=/opt/venv/bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
exec /app/bin/litellmctl _fg proxy --port 4040
RUN
chmod +x /etc/s6-overlay/s6-rc.d/litellm-proxy/run

cat > /etc/s6-overlay/s6-rc.d/gateway/run <<'RUN'
#!/command/with-contenv bash
set -euo pipefail
export PATH=/opt/venv/bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
exec /app/bin/litellmctl _fg gateway
RUN
chmod +x /etc/s6-overlay/s6-rc.d/gateway/run

cat > /etc/s6-overlay/s6-rc.d/caddy/run <<'RUN'
#!/command/with-contenv bash
set -euo pipefail
export XDG_DATA_HOME=/data/caddy
export XDG_CONFIG_HOME=/data/caddy
mkdir -p /data/caddy
exec /usr/local/bin/caddy run --config /data/Caddyfile --adapter caddyfile
RUN
chmod +x /etc/s6-overlay/s6-rc.d/caddy/run
SH

# ── Shell profile for the admin console ─────────────────────────────────────
# Every PTY spawned by the gateway console runs `bash -l`, which sources
# /etc/profile (which fans out to /etc/profile.d/*.sh) and /root/.bashrc.
# Put proxy env here so `claude` talks to the local LiteLLM out of the box.

RUN <<'SH'
set -eux
cat > /etc/profile.d/10-litellm-claude.sh <<'PROFILE'
# Admin-console shell profile — sets up Claude Code to use the local proxy.
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://localhost:4040}"
export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-${LITELLM_MASTER_KEY:-}}"
# Default tier aliases — override by setting these in /data/.env.
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-ultra}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-plus}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-lite}"
# Make litellmctl + claude + venv binaries directly invokable.
export PATH="/root/.local/bin:/opt/venv/bin:/root/.bun/bin:/app/bin:${PATH}"
PROFILE

cat > /root/.bashrc <<'BASHRC'
# Bash config for the admin console inside the gateway container.
# Source the shared profile so interactive non-login shells still get env.
[ -f /etc/profile.d/10-litellm-claude.sh ] && . /etc/profile.d/10-litellm-claude.sh

# Admin runs Claude with skip-permissions on by design — the container is
# the security boundary; the UI gate already proved admin role.
shopt -s expand_aliases
alias claude='claude --dangerously-skip-permissions'
alias ll='ls -la'

PS1='\[\e[1;34m\]litellm-gw\[\e[0m\]:\[\e[32m\]\w\[\e[0m\]\$ '
cd "${GATEWAY_DATA_DIR:-/app}" 2>/dev/null || true
BASHRC

# bash -l reads .bash_profile first if present; make sure it falls back to .bashrc.
cat > /root/.bash_profile <<'BPROFILE'
[ -f /root/.bashrc ] && . /root/.bashrc
BPROFILE

# Seed Claude Code's own settings.json so tier-aliased models work even when
# the user launches `claude` outside an interactive shell. The file is
# symlinked to /data/claude/settings.json by the entrypoint, so the admin
# can edit it from the console and the change survives container rebuilds.
mkdir -p /root/.claude
cat > /root/.claude/settings.json <<'SETTINGS'
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4040",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "ultra",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "plus",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "lite"
  }
}
SETTINGS
SH

EXPOSE 80 443 14041
VOLUME ["/data"]

# tini handles zombie reaping; s6-overlay's /init takes over as PID 1 manager.
ENTRYPOINT ["/usr/bin/tini", "--", "/init"]
