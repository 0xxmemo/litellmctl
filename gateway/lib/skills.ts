/**
 * Skills system library - reusable utilities for skill installation
 *
 * Skills can have these optional components:
 * - SKILL.md (required) - Manifest with metadata and instructions
 * - install.sh (optional) - Custom installation logic
 * - hook.sh (optional) - Claude Code hook script
 *
 * Cross-OS support: macOS (BSD) and Linux (GNU)
 */

import * as fs from "fs/promises";
import * as path from "path";

const SKILLS_DIR = path.join(import.meta.dir, "..", "..", "skills");
const SKILL_MANIFEST = "SKILL.md";

/**
 * Bash utility functions for cross-OS shell scripts.
 * All functions return bash code snippets that work on both macOS and Linux.
 */
export const bashUtils = {
  /**
   * Expand tilde to home directory - works on macOS and Linux.
   * Usage in generated scripts: ${bashUtils.expandTilde("SKILLS_DIR")}
   */
  expandTilde: (varName: string) => `${varName}="$(echo "$${varName}" | sed "s|^~|$HOME|g")"`,

  /**
   * Cross-platform sed -i replacement.
   * Usage: sed_inplace "pattern" "replacement" "file"
   * Note: This generates the function definition only - call sedInplaceFunc() for the full version with parameters.
   */
  sedInplaceFunc: () => `
sed_inplace() {
  local pattern="$1"
  local replacement="$2"
  local file="$3"
  if sed --version 2>/dev/null | grep -q GNU; then
    sed -i "s|\${pattern}|\${replacement}|g" "\$file"
  else
    sed -i '' "s|\${pattern}|\${replacement}|g" "\$file"
  fi
}
`.trim(),

  /**
   * Check if a command exists.
   * Usage: if has_command python3; then ...
   */
  hasCommand: () => `
has_command() {
  command -v "$1" &>/dev/null
}
`.trim(),

  /**
   * Safe file copy with fallback.
   * Usage: copy_file "$src" "$dst"
   */
  copyFile: () => `
copy_file() {
  local src="$1"
  local dst="$2"
  if [ -f "$src" ]; then
    cp "$src" "$dst" && return 0
  fi
  return 1
}
`.trim(),

  /**
   * Create directory if not exists.
   * Usage: ensure_dir "$dir"
   */
  ensureDir: () => `
ensure_dir() {
  mkdir -p "$1"
}
`.trim(),

  /**
   * Full set of bash utilities for cross-OS compatibility.
   * Include at the start of generated scripts.
   */
  allUtils: () => [
    bashUtils.hasCommand(),
    bashUtils.ensureDir(),
    bashUtils.copyFile(),
  ].join('\n\n'),
};

/**
 * Build gateway origin URL from request headers and environment.
 */
export function buildGatewayOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = url.hostname;
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const protocol = forwardedProto || (url.protocol === "https:" ? "https" : "http");
  const port = process.env.GATEWAY_PORT || "14041";
  return `${protocol}://${host}${protocol === "http" && port !== "443" && port !== "80" ? ":" + port : ""}`;
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frontmatterRegex = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;
  const match = normalized.match(frontmatterRegex);

  if (!match) {
    return { name: "", description: "" };
  }

  const [, yamlContent] = match;
  const metadata: Record<string, unknown> = {};

  for (const line of yamlContent.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1).trim();
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
export async function scanSkills(): Promise<Array<{
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
        continue;
      }
    }
  } catch {
    return [];
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Check if a skill has an optional component (hook.sh, install.sh, etc.)
 */
export async function hasSkillComponent(slug: string, component: string): Promise<boolean> {
  const skillDir = path.join(SKILLS_DIR, slug);
  const componentPath = path.join(skillDir, component);
  try {
    await fs.access(componentPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the content of a skill component.
 */
export async function getSkillComponent(slug: string, component: string): Promise<string | null> {
  const skillDir = path.join(SKILLS_DIR, slug);
  const componentPath = path.join(skillDir, component);
  try {
    await fs.access(componentPath);
    return await fs.readFile(componentPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Build the wrapper install script that downloads components and runs embedded install.sh.
 * All generated scripts are cross-OS compatible (macOS + Linux).
 */
export function buildInstallScript(
  slug: string,
  targetConfig: { name: string; skillsDir: string; configVar: string },
  gatewayOrigin: string,
  installContent: string | null
): string {
  const scriptLines = [
    '#!/usr/bin/env bash',
    `# Install ${slug} skill for ${targetConfig.name}`,
    '#',
    '# Usage:',
    `#   curl -fsSL "${gatewayOrigin}/api/skills/install.sh?slug=${slug}" | ${targetConfig.configVar}="sk-..." bash`,
    '#',
    '# Cross-OS: macOS (BSD) and Linux (GNU)',
    '#',
    'set -euo pipefail',
    '',
    '# --- Utility functions ---',
    bashUtils.hasCommand(),
    '',
    bashUtils.ensureDir(),
    '',
    bashUtils.sedInplaceFunc(),
    '',
    '# --- Configuration ---',
    `API_KEY="\${${targetConfig.configVar}:-}"`,
    `SKILLS_DIR_RAW="${targetConfig.skillsDir}"`,
    '',
    '# --- Validate API key ---',
    'if [ -z "$API_KEY" ]; then',
    `  echo "Error: ${targetConfig.configVar} is not set." >&2`,
    '  echo "" >&2',
    '  echo "Usage:" >&2',
    `  echo "  curl -fsSL \\"${gatewayOrigin}/api/skills/install.sh?slug=${slug}\\" | ${targetConfig.configVar}=\\"YOUR_KEY\\" bash" >&2`,
    '  exit 1',
    'fi',
    '',
    '# --- Setup directories ---',
    '# Expand tilde to home directory (cross-OS)',
    `SKILLS_DIR="$(echo "$SKILLS_DIR_RAW" | sed "s|^~|$HOME|g")"`,
    `SKILL_DIR="\${SKILLS_DIR}/${slug}"`,
    `SETTINGS_DIR="\${SKILLS_DIR%/skills}"`,
    `GATEWAY_ORIGIN="${gatewayOrigin}"`,
    `SKILL_SLUG="${slug}"`,
    '',
    'ensure_dir "${SKILL_DIR}"',
    'ensure_dir "${SETTINGS_DIR}/hooks"',
    '',
    `echo "Installing ${slug} skill for ${targetConfig.name}..."`,
    'echo "  Target directory: ${SKILL_DIR}"',
    '',
    '# --- Download SKILL.md ---',
    'if ! ORIGINAL_CONTENT=$(curl -fsSL "${GATEWAY_ORIGIN}/api/skills/SKILL.md?slug=${SKILL_SLUG}"); then',
    '  echo "Error: Failed to download SKILL.md" >&2',
    '  exit 1',
    'fi',
    '',
    '# Extract content after frontmatter (remove lines between and including --- markers)',
    "CONTENT=$(echo \"$ORIGINAL_CONTENT\" | sed -e '/^---$/,/^---$/d')",
    '',
    '# Generate frontmatter with injected values',
    'INSTALLED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")',
    '',
    '# Write installed SKILL.md',
    'cat > "${SKILL_DIR}/SKILL.md" << SKILL_EOF',
    '---',
    `name: ${slug}`,
    'target_platform: claude-code',
    'installed_at: ${INSTALLED_AT}',
    '---',
    '',
    '${CONTENT}',
    'SKILL_EOF',
    '',
  ];

  // Download hook.sh if present
  scriptLines.push(
    '# --- Download hook.sh if present ---',
    `if curl -fsSL -o "/tmp/hook_${slug}.sh" "\${GATEWAY_ORIGIN}/api/skills/hook.sh?slug=${slug}" 2>/dev/null; then`,
    `  mv "/tmp/hook_${slug}.sh" "\${SKILL_DIR}/hook.sh"`,
    '  chmod +x "${SKILL_DIR}/hook.sh"',
    `  echo "  Hook downloaded: \${SKILL_DIR}/hook.sh"`,
    'else',
    `  rm -f "/tmp/hook_${slug}.sh"`,
    '  echo "  Note: No hook.sh for this skill"',
    'fi',
    ''
  );

  // Embed install.sh if present
  if (installContent) {
    scriptLines.push(
      '# --- Run embedded install.sh ---',
      'echo "Running skill install..."',
      'export SKILLS_DIR="${SKILLS_DIR}"',
      'export SETTINGS_DIR="${SETTINGS_DIR}"',
      'export GATEWAY_ORIGIN="${GATEWAY_ORIGIN}"',
      'export API_KEY="${API_KEY}"',
      'export SKILL_SLUG="${SKILL_SLUG}"',
      'export SKILL_DIR="${SKILL_DIR}"',
      '# --- Embedded install.sh starts below ---',
      installContent,
      '# --- End of embedded install.sh ---',
      ''
    );
  }

  // Final success messages
  scriptLines.push(
    'echo ""',
    `echo "✅ ${slug} skill installed successfully!"`,
    'echo ""',
    'echo "  Skill directory: ${SKILL_DIR}"',
    'echo "  Documentation:   ${SKILL_DIR}/SKILL.md"',
    'echo "  Gateway URL:     ${GATEWAY_ORIGIN}"',
    `echo "  Target Platform: ${targetConfig.name}"`,
    'echo ""',
    `echo "The skill is now available for use with ${targetConfig.name}."`
  );

  return scriptLines.join('\n');
}

/**
 * Build the uninstall script that downloads and runs uninstall.sh for a skill.
 * Mirrors buildInstallScript structure but reverses the installation.
 */
export function buildUninstallScript(
  slug: string,
  targetConfig: { name: string; skillsDir: string; configVar: string },
  gatewayOrigin: string,
  uninstallContent: string | null
): string {
  const scriptLines = [
    '#!/usr/bin/env bash',
    `# Uninstall ${slug} skill for ${targetConfig.name}`,
    '#',
    '# Usage:',
    `#   curl -fsSL "${gatewayOrigin}/api/skills/uninstall.sh?slug=${slug}" | bash`,
    '#',
    '# Cross-OS: macOS (BSD) and Linux (GNU)',
    '#',
    'set -euo pipefail',
    '',
    '# --- Utility functions ---',
    bashUtils.hasCommand(),
    '',
    bashUtils.ensureDir(),
    '',
    '# --- Configuration ---',
    `SKILLS_DIR_RAW="${targetConfig.skillsDir}"`,
    '',
    '# --- Setup directories ---',
    '# Expand tilde to home directory (cross-OS)',
    `SKILLS_DIR="$(echo "$SKILLS_DIR_RAW" | sed "s|^~|$HOME|g")"`,
    `SKILL_DIR="\${SKILLS_DIR}/${slug}"`,
    `SETTINGS_DIR="\${SKILLS_DIR%/skills}"`,
    `SKILL_SLUG="${slug}"`,
    '',
    `echo "Uninstalling ${slug} skill for ${targetConfig.name}..."`,
    '',
  ];

  // Embed uninstall.sh if present
  if (uninstallContent) {
    scriptLines.push(
      '# --- Run embedded uninstall.sh ---',
      'export SKILLS_DIR="${SKILLS_DIR}"',
      'export SETTINGS_DIR="${SETTINGS_DIR}"',
      'export SKILL_SLUG="${SKILL_SLUG}"',
      'export SKILL_DIR="${SKILL_DIR}"',
      '# --- Embedded uninstall.sh starts below ---',
      uninstallContent,
      '# --- End of embedded uninstall.sh ---',
      ''
    );
  } else {
    // Generic uninstall: just remove the skill directory
    scriptLines.push(
      '# --- Generic uninstall (no uninstall.sh found) ---',
      'if [ -d "${SKILL_DIR}" ]; then',
      '  rm -rf "${SKILL_DIR}"',
      '  echo "  Removed skill directory: ${SKILL_DIR}"',
      'else',
      '  echo "  Skill directory not found (already removed)"',
      'fi',
      '',
      `echo ""`,
      `echo "${slug} skill uninstalled."`,
      ''
    );
  }

  return scriptLines.join('\n');
}

export { SKILLS_DIR, SKILL_MANIFEST };
