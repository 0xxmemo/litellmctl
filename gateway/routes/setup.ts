import { PORT } from "../lib/config";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SetupOption {
  id: string;
  name: string;
  description: string;
  icon: string;
  scriptUrl: string;
  configVar: string;
  docsUrl: string;
  features: string[];
  requirements: string[];
}

export interface SetupOptionsResponse {
  options: SetupOption[];
}

// ── Setup Option Definitions ────────────────────────────────────────────────
// Add new setup options here to extend available configurations

const SETUP_OPTIONS = {
  "claude-code": {
    name: "Claude Code",
    description:
      "Configure Claude Code to use LLM Gateway as your API provider",
    icon: "terminal",
    configVar: "LLM_GATEWAY_API_KEY",
    features: [
      "Creates ~/.claude/settings.json — non-destructive merge",
      "Sets ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN",
      "Maps model aliases: ultra / plus / lite",
      "Bypasses onboarding in ~/.claude.json",
    ],
    requirements: [
      "Claude Code CLI installed",
      "jq (auto-installed if missing)",
    ],
  },
  openclaw: {
    name: "OpenClaw",
    description: "Configure OpenClaw to use LLM Gateway as your API provider",
    icon: "bot",
    configVar: "LITELLM_API_KEY",
    features: [
      "Updates ~/.openclaw/openclaw.json — adds LLM Gateway provider",
      "Sets LITELLM_API_KEY in ~/.openclaw/.env",
      "Configures model aliases: litellm/ultra / litellm/plus / litellm/lite",
      "Sets up fallback chain: ultra → plus → lite",
    ],
    requirements: [
      "OpenClaw installed and initialized",
      "jq (auto-installed if missing)",
    ],
  },
} as const;

type SetupOptionId = keyof typeof SETUP_OPTIONS;

// ── Helper Functions ─────────────────────────────────────────────────────────

function getGatewayOrigin(url: URL, req: Request): string {
  const host = url.hostname;
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const protocol =
    forwardedProto || (url.protocol === "https:" ? "https" : "http");
  const port = PORT;
  return `${protocol}://${host}${protocol === "http" && port !== 443 && port !== 80 ? ":" + port : ""}`;
}

/**
 * GET /api/setup/options — Return all available setup options.
 * Public endpoint for docs discovery.
 */
async function getSetupOptionsHandler(): Promise<Response> {
  const options: SetupOption[] = Object.entries(SETUP_OPTIONS).map(
    ([key, value]) => ({
      id: key,
      name: value.name,
      description: value.description,
      icon: value.icon,
      scriptUrl: `/api/setup/${key}`,
      configVar: value.configVar,
      docsUrl: `/docs/setup/${key}`,
      features: [...value.features],
      requirements: [...value.requirements],
    }),
  );

  return Response.json({ options });
}

/**
 * GET /api/setup/:id — Return setup script for a specific option.
 * Public endpoint — no auth required.
 */
async function getSetupScript(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/");
  const id = pathParts[pathParts.length - 1] as SetupOptionId;

  // Validate setup option exists
  if (!(id in SETUP_OPTIONS)) {
    return Response.json({ error: "Invalid setup option" }, { status: 400 });
  }

  const config = SETUP_OPTIONS[id];
  const gatewayOrigin = getGatewayOrigin(url, req);

  // Generate setup script based on option type
  switch (id) {
    case "claude-code":
      return generateClaudeCodeScript(gatewayOrigin, config.configVar);
    case "openclaw":
      return generateOpenClawScript(gatewayOrigin, config.configVar);
    default:
      return Response.json(
        { error: "Setup script not found" },
        { status: 404 },
      );
  }
}

function generateClaudeCodeScript(
  gatewayOrigin: string,
  configVar: string,
): Response {
  const script = `#!/usr/bin/env bash
# Configure Claude Code to use LLM Gateway as your API provider.
#
# Usage:
#   curl -fsSL ${gatewayOrigin}/api/setup/claude-code | ${configVar}="sk-..." bash
#
set -euo pipefail

API_KEY="\${${configVar}:-}"

if [ -z "\$API_KEY" ]; then
  echo "Error: ${configVar} is not set." >&2
  echo "" >&2
  echo "Usage:" >&2
  echo "  curl -fsSL ${gatewayOrigin}/api/setup/claude-code | ${configVar}=\\"YOUR_KEY\\" bash" >&2
  exit 1
fi

CLAUDE_DIR="\$HOME/.claude"
SETTINGS_FILE="\$CLAUDE_DIR/settings.json"

mkdir -p "\$CLAUDE_DIR"

# Build or merge settings.json
if [ -f "\$SETTINGS_FILE" ]; then
  # Check if jq is available for safe JSON merging
  if command -v jq &>/dev/null; then
    tmp=\$(mktemp)
    jq --arg key "\$API_KEY" --arg url "${gatewayOrigin}/v1" \
       --arg opus "ultra" \
       --arg sonnet "plus" \
       --arg haiku "lite" '
      .env.ANTHROPIC_API_KEY = \$key |
      .env.ANTHROPIC_BASE_URL = \$url |
      .env.ANTHROPIC_DEFAULT_OPUS_MODEL = \$opus |
      .env.ANTHROPIC_DEFAULT_SONNET_MODEL = \$sonnet |
      .env.ANTHROPIC_DEFAULT_HAIKU_MODEL = \$haiku
    ' "\$SETTINGS_FILE" > "\$tmp" && mv "\$tmp" "\$SETTINGS_FILE"
  else
    echo "Warning: jq not found. Overwriting settings.json." >&2
    cat > "\$SETTINGS_FILE" <<JSONEOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "${gatewayOrigin}/v1",
    "ANTHROPIC_API_KEY": "\$API_KEY",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "ultra",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "plus",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "lite"
  }
}
JSONEOF
  fi
else
  cat > "\$SETTINGS_FILE" <<JSONEOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "${gatewayOrigin}/v1",
    "ANTHROPIC_API_KEY": "\$API_KEY",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "ultra",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "plus",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "lite"
  }
}
JSONEOF
fi

echo "Claude Code configured successfully!"
echo ""
echo "  API Base URL:  ${gatewayOrigin}/v1"
echo "  Settings file: \$SETTINGS_FILE"
echo ""
echo "Run 'claude' to start using Claude Code through LLM Gateway."
`;

  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

function generateOpenClawScript(
  gatewayOrigin: string,
  configVar: string,
): Response {
  const script = `#!/usr/bin/env bash
# Configure OpenClaw to use LLM Gateway as your API provider.
#
# Usage:
#   curl -fsSL ${gatewayOrigin}/api/setup/openclaw | ${configVar}="sk-..." bash
#
set -euo pipefail

API_KEY="\${${configVar}:-}"

if [ -z "\$API_KEY" ]; then
  echo "Error: ${configVar} is not set." >&2
  echo "" >&2
  echo "Usage:" >&2
  echo "  curl -fsSL ${gatewayOrigin}/api/setup/openclaw | ${configVar}=\\"YOUR_KEY\\" bash" >&2
  exit 1
fi

OPENCLAW_DIR="\$HOME/.openclaw"
CONFIG_FILE="\$OPENCLAW_DIR/openclaw.json"
ENV_FILE="\$OPENCLAW_DIR/.env"

mkdir -p "\$OPENCLAW_DIR"

# Add ${configVar} to .env file (non-destructive)
if [ -f "\$ENV_FILE" ]; then
  # Remove existing ${configVar} line if present
  grep -v "^${configVar}=" "\$ENV_FILE" > "\$ENV_FILE.tmp" || true
  mv "\$ENV_FILE.tmp" "\$ENV_FILE"
  echo "${configVar}=\$API_KEY" >> "\$ENV_FILE"
else
  echo "${configVar}=\$API_KEY" > "\$ENV_FILE"
fi

# Update openclaw.json with LLM Gateway provider
if [ -f "\$CONFIG_FILE" ]; then
  if command -v jq &>/dev/null; then
    tmp=\$(mktemp)
    jq --arg key "\${API_KEY}" --arg url "${gatewayOrigin}" \
       --arg opus "ultra" \
       --arg sonnet "plus" \
       --arg haiku "lite" '
      .models.providers.litellm = {
        "baseUrl": \$url,
        "apiKey": "${configVar}",
        "api": "anthropic-messages",
        "models": [
          {"id": "ultra", "name": "LLM Gateway Ultra"},
          {"id": "plus", "name": "LLM Gateway Plus"},
          {"id": "lite", "name": "LLM Gateway Lite"}
        ]
      } |
      .agents.defaults.model.primary = "litellm/ultra" |
      .agents.defaults.model.fallbacks = ["litellm/plus", "litellm/lite"]
    ' "\$CONFIG_FILE" > "\$tmp" && mv "\$tmp" "\$CONFIG_FILE"
  else
    echo "Warning: jq not found. Updating openclaw.json models section." >&2
    tmp=\$(mktemp)
    jq --arg url "${gatewayOrigin}" '
      .models.providers.litellm = {
        "baseUrl": \$url,
        "apiKey": "${configVar}",
        "api": "anthropic-messages",
        "models": [
          {"id": "ultra", "name": "LLM Gateway Ultra"},
          {"id": "plus", "name": "LLM Gateway Plus"},
          {"id": "lite", "name": "LLM Gateway Lite"}
        ]
      } |
      .agents.defaults.model.primary = "litellm/ultra" |
      .agents.defaults.model.fallbacks = ["litellm/plus", "litellm/lite"]
    ' "\$CONFIG_FILE" > "\$tmp" && mv "\$tmp" "\$CONFIG_FILE"
  fi
else
  echo "Error: openclaw.json not found at \$CONFIG_FILE" >&2
  echo "Please run the OpenClaw wizard first to create the config file." >&2
  exit 1
fi

echo "OpenClaw configured successfully!"
echo ""
echo "  Gateway URL:   ${gatewayOrigin}"
echo "  Config file:   \$CONFIG_FILE"
echo "  Env file:      \$ENV_FILE"
echo ""
echo "Restart OpenClaw to apply changes."
`;

  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

// ── Route Exports ────────────────────────────────────────────────────────────

export const setupRoutes = {
  "/api/setup/options": { GET: getSetupOptionsHandler },
  "/api/setup/claude-code": { GET: getSetupScript },
  "/api/setup/openclaw": { GET: getSetupScript },
};
