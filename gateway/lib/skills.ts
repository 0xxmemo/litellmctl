/**
 * Skills system library — mirrors lib/plugins.ts.
 *
 * Skill directory layout:
 *   skills/<slug>/
 *     SKILL.md        — frontmatter + docs (required)
 *     install.sh      — runs inline during install (optional)
 *     uninstall.sh    — runs inline during uninstall (optional)
 *     hook.sh         — Claude Code UserPromptSubmit hook (optional)
 *     run.sh          — runnable entry point (optional). install.sh is
 *                        responsible for rewriting placeholders
 *                        (e.g. __GATEWAY_URL__, __API_KEY__).
 *
 * Installation flow (parallels plugins):
 *   1. Client curls /api/skills/install.sh — gets a wrapper script.
 *   2. Wrapper downloads /api/skills/bundle.tar.gz and extracts into the
 *      target's skills dir. Archive root is `<slug>/` so a single `tar -xzf`
 *      recreates the whole skill dir cleanly.
 *   3. Wrapper overwrites SKILL.md with install-time frontmatter.
 *   4. Wrapper execs the bundled install.sh, which wires up hooks, rewrites
 *      placeholders in run.sh, etc. — all files it needs are already on disk.
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

export function parseFrontmatter(content: string): Record<string, unknown> {
  const normalized = content.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frontmatterRegex = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;
  const match = normalized.match(frontmatterRegex);
  if (!match) return { name: "", description: "" };

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

export interface SkillManifest {
  name: string;
  slug: string;
  description: string;
  installUrl: string;
  docsUrl: string;
}

export async function scanSkills(): Promise<SkillManifest[]> {
  const skills: SkillManifest[] = [];
  try {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const manifestPath = path.join(SKILLS_DIR, slug, SKILL_MANIFEST);
      try {
        await fs.access(manifestPath);
        const content = await fs.readFile(manifestPath, "utf-8");
        const metadata = parseFrontmatter(content);
        skills.push({
          name: (metadata.name as string) || slug,
          slug,
          description: (metadata.description as string) || "",
          installUrl: `/api/skills/install.sh?slug=${slug}`,
          docsUrl: `/api/skills/SKILL.md?slug=${slug}`,
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

export async function hasSkillComponent(slug: string, component: string): Promise<boolean> {
  if (!/^[a-z0-9-]+$/.test(slug)) return false;
  try {
    await fs.access(path.join(SKILLS_DIR, slug, component));
    return true;
  } catch {
    return false;
  }
}

export async function getSkillComponent(slug: string, component: string): Promise<string | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const componentPath = path.join(SKILLS_DIR, slug, component);
  try {
    await fs.access(componentPath);
    return await fs.readFile(componentPath, "utf-8");
  } catch {
    return null;
  }
}

// ── Script generation ───────────────────────────────────────────────────────

export interface SkillTargetConfig {
  name: string;
  skillsDir: string;   // e.g. ~/.claude/skills
  settingsDir: string; // e.g. ~/.claude — used by install.sh for hooks
  configVar: string;   // env var name for the API key
}

export function buildInstallScript(
  slug: string,
  targetConfig: SkillTargetConfig,
  gatewayOrigin: string,
  installContent: string | null,
): string {
  const usageUrl = `${gatewayOrigin}/api/skills/install.sh?slug=${slug}`;

  const embeddedInstall = installContent
    ? `
# --- Run embedded install.sh ---
echo "Running skill install..."
export SKILLS_DIR="\${SKILLS_DIR}"
export SKILL_DIR="\${SKILL_DIR}"
export SETTINGS_DIR="\${SETTINGS_DIR}"
export GATEWAY_ORIGIN="\${GATEWAY_ORIGIN}"
export API_KEY="\${API_KEY}"
export SKILL_SLUG="\${SKILL_SLUG}"
# --- Embedded install.sh starts below ---
${installContent}
# --- End of embedded install.sh ---`
    : `
# --- No install.sh provided ---
echo "Skill '${slug}' ships no install.sh; extraction is all that's needed."
`;

  return `${scriptPreamble(`Install ${slug} skill for ${targetConfig.name}`)}
${scriptValidateKey(targetConfig.configVar, usageUrl)}

# --- Setup directories ---
SKILLS_DIR_RAW="${targetConfig.skillsDir}"
${scriptExpandTilde("SKILLS_DIR_RAW")}
SKILLS_DIR="\$SKILLS_DIR_RAW"
SKILL_DIR="\${SKILLS_DIR}/${slug}"
SETTINGS_DIR_RAW="${targetConfig.settingsDir}"
${scriptExpandTilde("SETTINGS_DIR_RAW")}
SETTINGS_DIR="\$SETTINGS_DIR_RAW"
GATEWAY_ORIGIN="${gatewayOrigin}"
SKILL_SLUG="${slug}"

ensure_dir "\${SKILLS_DIR}"
ensure_dir "\${SETTINGS_DIR}"

echo "Installing ${slug} skill for ${targetConfig.name}..."
echo "  Skill dir:    \${SKILL_DIR}"
echo "  Settings dir: \${SETTINGS_DIR}"

# --- Download skill bundle from gateway ---
if ! has_command curl; then
  echo "Error: curl is required to download the skill bundle." >&2
  exit 1
fi
if ! has_command tar; then
  echo "Error: tar is required to extract the skill bundle." >&2
  exit 1
fi

BUNDLE_URL="\${GATEWAY_ORIGIN}/api/skills/bundle.tar.gz?slug=\${SKILL_SLUG}"
TMPTAR="\$(mktemp -t skill-${slug}.XXXXXX)"
trap 'rm -f "\$TMPTAR"' EXIT
echo "  Downloading skill bundle from \${BUNDLE_URL}..."
if ! curl -fsSL "\$BUNDLE_URL" -o "\$TMPTAR"; then
  echo "Error: failed to download skill bundle." >&2
  exit 1
fi

# Clean-install: archive root is "${slug}/", extract into skills/ to (re)create SKILL_DIR.
rm -rf "\${SKILL_DIR}"
if ! tar -xzf "\$TMPTAR" -C "\${SKILLS_DIR}"; then
  echo "Error: failed to extract skill bundle." >&2
  exit 1
fi
echo "  Skill bundle extracted to \${SKILL_DIR}"

# --- Overwrite SKILL.md with install-time frontmatter ---
if ORIGINAL_CONTENT=\$(curl -fsSL "\${GATEWAY_ORIGIN}/api/skills/SKILL.md?slug=\${SKILL_SLUG}"); then
  CONTENT=\$(echo "\$ORIGINAL_CONTENT" | sed -e '/^---\$/,/^---\$/d')
  INSTALLED_AT=\$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  cat > "\${SKILL_DIR}/SKILL.md" << SKILL_EOF
---
name: ${slug}
target_platform: ${targetConfig.name}
installed_at: \${INSTALLED_AT}
---

\${CONTENT}
SKILL_EOF
  echo "  SKILL.md written to \${SKILL_DIR}/SKILL.md"
fi
${embeddedInstall}

echo ""
echo "${slug} skill installed successfully!"
echo ""
echo "  Skill dir:       \${SKILL_DIR}"
echo "  Documentation:   \${SKILL_DIR}/SKILL.md"
echo "  LitellmCTL URL:  \${GATEWAY_ORIGIN}"
echo "  Target Platform: ${targetConfig.name}"
`;
}

export function buildUninstallScript(
  slug: string,
  targetConfig: SkillTargetConfig,
  _gatewayOrigin: string,
  uninstallContent: string | null,
): string {
  const uninstallBody = uninstallContent
    ? `
# --- Run embedded uninstall.sh ---
export SKILLS_DIR="\${SKILLS_DIR}"
export SKILL_DIR="\${SKILL_DIR}"
export SETTINGS_DIR="\${SETTINGS_DIR}"
export SKILL_SLUG="\${SKILL_SLUG}"
# --- Embedded uninstall.sh starts below ---
${uninstallContent}
# --- End of embedded uninstall.sh ---`
    : `
# --- Generic uninstall (no uninstall.sh found) ---
if [ -d "\${SKILL_DIR}" ]; then
  rm -rf "\${SKILL_DIR}"
  echo "  Removed skill directory: \${SKILL_DIR}"
fi
echo ""
echo "${slug} skill uninstalled."`;

  return `${scriptPreamble(`Uninstall ${slug} skill for ${targetConfig.name}`)}

# --- Setup directories ---
SKILLS_DIR_RAW="${targetConfig.skillsDir}"
${scriptExpandTilde("SKILLS_DIR_RAW")}
SKILLS_DIR="\$SKILLS_DIR_RAW"
SKILL_DIR="\${SKILLS_DIR}/${slug}"
SETTINGS_DIR_RAW="${targetConfig.settingsDir}"
${scriptExpandTilde("SETTINGS_DIR_RAW")}
SETTINGS_DIR="\$SETTINGS_DIR_RAW"
SKILL_SLUG="${slug}"

echo "Uninstalling ${slug} skill for ${targetConfig.name}..."
${uninstallBody}
`;
}

export { SKILLS_DIR, SKILL_MANIFEST };
