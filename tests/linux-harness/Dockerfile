# Ubuntu 24.04 consumer environment for the install-flow harness.
# Matches what a normal end-user on Ubuntu would have: bash, curl, tar, a
# recent Python, jq (optional alt path in supermemory install), and bun
# (required by the supermemory/claude-context plugins). Zsh is included so
# we can also exercise the zsh paste path.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash zsh curl ca-certificates tar gzip python3 jq unzip \
    && rm -rf /var/lib/apt/lists/*

# bun (required by supermemory + claude-context plugins)
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# A stub `claude` on PATH. claude-context's install.sh only checks that the
# binary exists and shells out to `claude mcp add-json`. The harness validates
# the shell/pipe path, not the MCP registration — so a stub that accepts any
# args and exits 0 faithfully simulates a Linux consumer who has Claude Code
# installed, without dragging the real CLI into the test image.
RUN printf '#!/usr/bin/env bash\nexit 0\n' > /usr/local/bin/claude \
    && chmod +x /usr/local/bin/claude

ENV HOME=/root
WORKDIR /root

COPY container-test.sh /usr/local/bin/container-test.sh
RUN chmod +x /usr/local/bin/container-test.sh

ENTRYPOINT ["/usr/local/bin/container-test.sh"]
