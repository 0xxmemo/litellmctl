/**
 * Skills system library — skill discovery, component loading, and script generation.
 *
 * Script generation uses template literals (same pattern as setup scripts)
 * and imports shared utilities from lib/scripts.ts.
 *
 * Skills can have these optional components:
 * - SKILL.md (required) - Manifest with metadata and instructions
 * - install.sh (optional) - Custom installation logic
 * - uninstall.sh (optional) - Custom uninstallation logic
 * - hook.sh (optional) - Claude Code hook script
 */

import * as fs from "fs/promises";
import * as path from "path";

import {
  scriptPreamble,
  scriptValidateKey,
  scriptExpandTilde,
} from "./scripts";

const SKILLS_DIR = path.join(import.meta.dir, "..", "..", "skills");
const SKILL_MANIFEST = "SKILL.md";

// ── Frontmatter parsing ─────────────────────────────────────────────────────

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

// ── Skill discovery ─────────────────────────────────────────────────────────

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

// ── Component access ────────────────────────────────────────────────────────

/**
 * Check if a skill has an optional component (hook.sh, install.sh, etc.)
 */
export async function hasSkillComponent(slug: string, component: string): Promise<boolean> {
  const componentPath = path.join(SKILLS_DIR, slug, component);
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
  const componentPath = path.join(SKILLS_DIR, slug, component);
  try {
    await fs.access(componentPath);
    return await fs.readFile(componentPath, "utf-8");
  } catch {
    return null;
  }
}

// ── Script generation ───────────────────────────────────────────────────────
// Uses template literals (not array joining) for clean, cross-platform output.

/**
 * Build the install script for a skill.
 */
export function buildInstallScript(
  slug: string,
  targetConfig: { name: string; skillsDir: string; configVar: string },
  gatewayOrigin: string,
  installContent: string | null
): string {
  const usageUrl = `${gatewayOrigin}/api/skills/install.sh?slug=${slug}`;

  // Build the embedded install section
  const embeddedInstall = installContent
    ? `
# --- Run embedded install.sh ---
echo "Running skill install..."
export SKILLS_DIR="\${SKILLS_DIR}"
export SETTINGS_DIR="\${SETTINGS_DIR}"
export GATEWAY_ORIGIN="\${GATEWAY_ORIGIN}"
export API_KEY="\${API_KEY}"
export SKILL_SLUG="\${SKILL_SLUG}"
export SKILL_DIR="\${SKILL_DIR}"
# --- Embedded install.sh starts below ---
${installContent}
# --- End of embedded install.sh ---`
    : "";

  return `${scriptPreamble(`Install ${slug} skill for ${targetConfig.name}`)}
${scriptValidateKey(targetConfig.configVar, usageUrl)}

# --- Setup directories ---
SKILLS_DIR_RAW="${targetConfig.skillsDir}"
${scriptExpandTilde("SKILLS_DIR_RAW")}
SKILLS_DIR="\$SKILLS_DIR_RAW"
SKILL_DIR="\${SKILLS_DIR}/${slug}"
SETTINGS_DIR="\${SKILLS_DIR%/skills}"
GATEWAY_ORIGIN="${gatewayOrigin}"
SKILL_SLUG="${slug}"

ensure_dir "\${SKILL_DIR}"
ensure_dir "\${SETTINGS_DIR}/hooks"

echo "Installing ${slug} skill for ${targetConfig.name}..."
echo "  Target directory: \${SKILL_DIR}"

# --- Download SKILL.md ---
if ! ORIGINAL_CONTENT=\$(curl -fsSL "\${GATEWAY_ORIGIN}/api/skills/SKILL.md?slug=\${SKILL_SLUG}"); then
  echo "Error: Failed to download SKILL.md" >&2
  exit 1
fi

# Extract content after frontmatter (remove lines between and including --- markers)
CONTENT=\$(echo "\$ORIGINAL_CONTENT" | sed -e '/^---\$/,/^---\$/d')

# Generate frontmatter with injected values
INSTALLED_AT=\$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Write installed SKILL.md
cat > "\${SKILL_DIR}/SKILL.md" << SKILL_EOF
---
name: ${slug}
target_platform: claude-code
installed_at: \${INSTALLED_AT}
---

\${CONTENT}
SKILL_EOF

# --- Download hook.sh if present ---
if curl -fsSL -o "/tmp/hook_${slug}.sh" "\${GATEWAY_ORIGIN}/api/skills/hook.sh?slug=${slug}" 2>/dev/null; then
  mv "/tmp/hook_${slug}.sh" "\${SKILL_DIR}/hook.sh"
  chmod +x "\${SKILL_DIR}/hook.sh"
  echo "  Hook downloaded: \${SKILL_DIR}/hook.sh"
else
  rm -f "/tmp/hook_${slug}.sh"
  echo "  Note: No hook.sh for this skill"
fi
${embeddedInstall}

echo ""
echo "${slug} skill installed successfully!"
echo ""
echo "  Skill directory: \${SKILL_DIR}"
echo "  Documentation:   \${SKILL_DIR}/SKILL.md"
echo "  LitellmCTL URL:  \${GATEWAY_ORIGIN}"
echo "  Target Platform: ${targetConfig.name}"
echo ""
echo "The skill is now available for use with ${targetConfig.name}."
`;
}

/**
 * Build the uninstall script for a skill.
 */
export function buildUninstallScript(
  slug: string,
  targetConfig: { name: string; skillsDir: string; configVar: string },
  _gatewayOrigin: string,
  uninstallContent: string | null
): string {
  // Build the embedded uninstall section or generic fallback
  const uninstallBody = uninstallContent
    ? `
# --- Run embedded uninstall.sh ---
export SKILLS_DIR="\${SKILLS_DIR}"
export SETTINGS_DIR="\${SETTINGS_DIR}"
export SKILL_SLUG="\${SKILL_SLUG}"
export SKILL_DIR="\${SKILL_DIR}"
# --- Embedded uninstall.sh starts below ---
${uninstallContent}
# --- End of embedded uninstall.sh ---`
    : `
# --- Generic uninstall (no uninstall.sh found) ---
if [ -d "\${SKILL_DIR}" ]; then
  rm -rf "\${SKILL_DIR}"
  echo "  Removed skill directory: \${SKILL_DIR}"
else
  echo "  Skill directory not found (already removed)"
fi

echo ""
echo "${slug} skill uninstalled."`;

  return `${scriptPreamble(`Uninstall ${slug} skill for ${targetConfig.name}`)}

# --- Setup directories ---
SKILLS_DIR_RAW="${targetConfig.skillsDir}"
${scriptExpandTilde("SKILLS_DIR_RAW")}
SKILLS_DIR="\$SKILLS_DIR_RAW"
SKILL_DIR="\${SKILLS_DIR}/${slug}"
SETTINGS_DIR="\${SKILLS_DIR%/skills}"
SKILL_SLUG="${slug}"

echo "Uninstalling ${slug} skill for ${targetConfig.name}..."
${uninstallBody}
`;
}

export { SKILLS_DIR, SKILL_MANIFEST };
