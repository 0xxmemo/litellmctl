import { requireAuth } from "../lib/db";
import * as fs from "fs/promises";
import * as path from "path";

const SKILLS_DIR = path.join(import.meta.dir, "..", "..", "skills");
const SKILL_MANIFEST = "SKILL.md";

// Target platforms for skill installation
// Currently only Claude Code is supported - other targets are placeholders for future extension
const INSTALL_TARGETS = {
  "claude-code": {
    name: "Claude Code",
    skillsDir: "~/.claude/skills",
    configVar: "LLM_GATEWAY_API_KEY",
    // Claude Code skills use environment variables for runtime config
    envVars: {
      gatewayUrl: "GATEWAY_URL",
      apiKey: "API_KEY",
    },
    // Claude Code skill template with frontmatter
    template: (name: string, gatewayUrl: string, apiKey: string, content: string) => {
      return `---
name: ${name}
gateway_url: ${gatewayUrl}
api_key: ${apiKey}
target_platform: claude-code
installed_at: ${new Date().toISOString()}
---

${content}`;
    },
  },
} as const;

type InstallTarget = keyof typeof INSTALL_TARGETS;

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Returns metadata object with name, description, and any additional fields.
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frontmatterRegex = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;
  const match = normalized.match(frontmatterRegex);

  if (!match) {
    return { name: "", description: "" };
  }

  const [, yamlContent] = match;
  const metadata: Record<string, unknown> = {};

  // Simple YAML parser for key: value pairs
  for (const line of yamlContent.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1).trim();
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      metadata[key] = value;
    }
  }

  return metadata;
}

/**
 * Scan skills directory and return manifest of all valid skills.
 */
async function scanSkills(): Promise<Array<{
  name: string;
  slug: string;
  description: string;
  installUrl: string;
  docsUrl: string;
}>> {
  const skills: Array<{
    name: string;
    slug: string;
    description: string;
    installUrl: string;
    docsUrl: string;
  }> = [];

  try {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillSlug = entry.name;
      const skillDir = path.join(SKILLS_DIR, skillSlug);
      const manifestPath = path.join(skillDir, SKILL_MANIFEST);

      try {
        await fs.access(manifestPath);
        const content = await fs.readFile(manifestPath, "utf-8");
        const metadata = parseFrontmatter(content);

        const name = (metadata.name as string) || skillSlug;
        const description = (metadata.description as string) || "";

        skills.push({
          name,
          slug: skillSlug,
          description,
          installUrl: `/api/skills/install.sh?slug=${skillSlug}`,
          docsUrl: `/api/skills/SKILL.md?slug=${skillSlug}`,
        });
      } catch {
        // Skip directories without valid SKILL.md
        continue;
      }
    }
  } catch {
    // Skills directory doesn't exist or can't be read
    return [];
  }

  // Sort by name for consistent ordering
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * GET /api/skills — Return manifest of all available skills.
 * Public endpoint (no auth required) for docs discovery.
 */
async function getSkillsHandler(): Promise<Response> {
  const skills = await scanSkills();
  return Response.json({ skills });
}

/**
 * GET /api/skills/targets — Return available install targets.
 */
async function getInstallTargetsHandler(): Promise<Response> {
  const targets = Object.entries(INSTALL_TARGETS).map(([key, value]) => ({
    id: key,
    name: value.name,
    skillsDir: value.skillsDir,
    configVar: value.configVar,
  }));
  return Response.json({ targets });
}

/**
 * GET /skills/install.sh?slug=:slug — Return install script for a skill.
 * Supports target platform selection via query param: ?target=claude-code
 */
async function getSkillInstallScript(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  // Get slug from query param
  const slug = url.searchParams.get("slug") || "";

  // Get target from query param, default to claude-code
  const targetParam = url.searchParams.get("target") || "claude-code";
  const target = (targetParam as InstallTarget) in INSTALL_TARGETS
    ? (targetParam as InstallTarget)
    : "claude-code";

  const targetConfig = INSTALL_TARGETS[target];

  // Validate slug (alphanumeric + hyphen only)
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid skill name" }, { status: 400 });
  }

  // Verify skill exists
  const skillDir = path.join(SKILLS_DIR, slug);
  const manifestPath = path.join(skillDir, SKILL_MANIFEST);

  try {
    await fs.access(manifestPath);
  } catch {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }

  // Build gateway origin (same pattern as setup.ts)
  const host = url.hostname;
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const protocol = forwardedProto || (url.protocol === "https:" ? "https" : "http");
  const port = process.env.GATEWAY_PORT || "14041";
  const gatewayOrigin = `${protocol}://${host}${protocol === "http" && port !== "443" && port !== "80" ? ":" + port : ""}`;

  // Build install script line by line to avoid template literal escaping issues
  const scriptLines = [
    '#!/usr/bin/env bash',
    `# Install ${slug} skill for ${targetConfig.name}`,
    '#',
    '# Usage:',
    `#   curl -fsSL "${gatewayOrigin}/api/skills/install.sh?slug=${slug}&target=${target}" | ${targetConfig.configVar}="sk-..." bash`,
    '#',
    'set -euo pipefail',
    '',
    'API_KEY="${' + targetConfig.configVar + ':-}"',
    '',
    'if [ -z "$API_KEY" ]; then',
    `  echo "Error: ${targetConfig.configVar} is not set." >&2`,
    '  echo "" >&2',
    '  echo "Usage:" >&2',
    `  echo "  curl -fsSL \\"${gatewayOrigin}/skills/${slug}/install.sh?target=${target}\\" | ${targetConfig.configVar}=\\\"YOUR_KEY\\\" bash" >&2`,
    '  exit 1',
    'fi',
    '',
    '# Expand tilde to home directory',
    'SKILLS_DIR_RAW="' + targetConfig.skillsDir + '"',
    'SKILLS_DIR="$(echo "$SKILLS_DIR_RAW" | sed "s|^~|$HOME|g")"',
    'SKILL_DIR="${SKILLS_DIR}/' + slug + '"',
    '',
    'mkdir -p "${SKILL_DIR}"',
    '',
    'echo "Installing ' + slug + ' skill for ' + targetConfig.name + '..."',
    'echo "  Target directory: ${SKILL_DIR}"',
    '',
    '# Download original SKILL.md',
    'ORIGINAL_CONTENT=$(curl -fsSL "' + gatewayOrigin + '/api/skills/SKILL.md?slug=' + slug + '")',
    '',
    '# Extract content after frontmatter (skip lines between and including --- markers)',
    'CONTENT=$(echo "$ORIGINAL_CONTENT" | sed -e \'/^---$/,/^---$/d\')',
    '',
    '# Generate new frontmatter with injected values',
    'INSTALLED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")',
    '',
    '# Write the installed skill with injected frontmatter',
    'cat > "${SKILL_DIR}/SKILL.md" << SKILL_EOF',
    '---',
    'name: ' + slug,
    'gateway_url: ' + gatewayOrigin,
    'api_key: ${API_KEY}',
    'target_platform: ' + target,
    'installed_at: ${INSTALLED_AT}',
    '---',
    '',
    '${CONTENT}',
    'SKILL_EOF',
    '',
    'echo ""',
    'echo "✅ ' + slug + ' skill installed successfully!"',
    'echo ""',
    'echo "  Skill directory: ${SKILL_DIR}"',
    'echo "  Documentation:   ${SKILL_DIR}/SKILL.md"',
    'echo "  Gateway URL:     ' + gatewayOrigin + '"',
    'echo "  Target Platform: ' + targetConfig.name + '"',
    'echo ""',
    'echo "The skill is now available for use with ' + targetConfig.name + '."',
    'echo ""',
    'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"',
    'echo ""',
    'echo "Security Note:"',
    'echo "  - API key is stored in ${SKILL_DIR}/SKILL.md"',
    'echo "  - Ensure this file has restricted permissions: chmod 600 ${SKILL_DIR}/SKILL.md"',
    'echo ""',
    'chmod 600 "${SKILL_DIR}/SKILL.md"',
  ];
  const script = scriptLines.join('\n');

  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * GET /skills/SKILL.md?slug=:slug — Return raw SKILL.md content.
 * Used by install script and docs display.
 */
async function getSkillManifest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Get slug from query param
  const slug = url.searchParams.get("slug") || "";

  // Validate slug
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid skill name" }, { status: 400 });
  }

  const skillDir = path.join(SKILLS_DIR, slug);
  const manifestPath = path.join(skillDir, SKILL_MANIFEST);

  try {
    await fs.access(manifestPath);
    const content = await fs.readFile(manifestPath, "utf-8");
    return new Response(content, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }
}

export const skillsRoutes = {
  "/api/skills": { GET: getSkillsHandler },
  "/api/skills/targets": { GET: getInstallTargetsHandler },
  "/api/skills/install.sh": { GET: getSkillInstallScript },
  "/api/skills/SKILL.md": { GET: getSkillManifest },
};
