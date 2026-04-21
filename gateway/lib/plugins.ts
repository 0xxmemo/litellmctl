/**
 * Plugins system library — mirrors lib/skills.ts but installs MCP servers
 * into the target's settings.json (mcpServers) rather than UserPromptSubmit hooks.
 *
 * Plugin directory layout:
 *   plugins/<slug>/
 *     PLUGIN.md       — frontmatter + docs (required)
 *     install.sh      — runs inline during install (required)
 *     uninstall.sh    — runs inline during uninstall (optional)
 *     src/**          — source files (e.g. MCP server entry)
 *     package.json    — plugin deps (installed once via bun install)
 */

import * as fs from "fs/promises";
import * as path from "path";

import {
  scriptPreamble,
  scriptValidateKey,
  scriptExpandTilde,
} from "./scripts";

const PLUGINS_DIR = path.join(import.meta.dir, "..", "..", "plugins");
const PLUGIN_MANIFEST = "PLUGIN.md";

// ── Frontmatter parsing ─────────────────────────────────────────────────────

export function parseFrontmatter(content: string): Record<string, unknown> {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frontmatterRegex = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;
  const match = normalized.match(frontmatterRegex);
  if (!match) return { name: "", description: "", type: "" };

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

// ── Plugin discovery ────────────────────────────────────────────────────────

export interface PluginManifest {
  name: string;
  slug: string;
  description: string;
  type: string; // "mcp" | "hook" | etc.
  installUrl: string;
  docsUrl: string;
}

export async function scanPlugins(): Promise<PluginManifest[]> {
  const plugins: PluginManifest[] = [];
  try {
    const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const manifestPath = path.join(PLUGINS_DIR, slug, PLUGIN_MANIFEST);
      try {
        await fs.access(manifestPath);
        const content = await fs.readFile(manifestPath, "utf-8");
        const metadata = parseFrontmatter(content);
        plugins.push({
          name: (metadata.name as string) || slug,
          slug,
          description: (metadata.description as string) || "",
          type: (metadata.type as string) || "mcp",
          installUrl: `/api/plugins/install.sh?slug=${slug}`,
          docsUrl: `/api/plugins/PLUGIN.md?slug=${slug}`,
        });
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return plugins;
}

// ── Component access ────────────────────────────────────────────────────────

export async function hasPluginComponent(slug: string, component: string): Promise<boolean> {
  if (!/^[a-z0-9-]+$/.test(slug)) return false;
  try {
    await fs.access(path.join(PLUGINS_DIR, slug, component));
    return true;
  } catch {
    return false;
  }
}

export async function getPluginComponent(slug: string, component: string): Promise<string | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const componentPath = path.join(PLUGINS_DIR, slug, component);
  try {
    await fs.access(componentPath);
    return await fs.readFile(componentPath, "utf-8");
  } catch {
    return null;
  }
}

// ── Script generation ───────────────────────────────────────────────────────

export interface PluginTargetConfig {
  name: string;
  settingsDir: string; // e.g. ~/.claude
  configVar: string;   // env var name for the API key
}

export function buildInstallScript(
  slug: string,
  targetConfig: PluginTargetConfig,
  gatewayOrigin: string,
  installContent: string | null,
): string {
  const usageUrl = `${gatewayOrigin}/api/plugins/install.sh?slug=${slug}`;

  const embeddedInstall = installContent
    ? `
# --- Run embedded install.sh ---
echo "Running plugin install..."
export PLUGIN_DIR="\${PLUGIN_DIR}"
export SETTINGS_DIR="\${SETTINGS_DIR}"
export GATEWAY_ORIGIN="\${GATEWAY_ORIGIN}"
export API_KEY="\${API_KEY}"
export PLUGIN_SLUG="\${PLUGIN_SLUG}"
export PLUGIN_SRC_DIR="\${PLUGIN_SRC_DIR}"
# --- Embedded install.sh starts below ---
${installContent}
# --- End of embedded install.sh ---`
    : `
# --- No install.sh provided ---
echo "Plugin '${slug}' does not ship an install.sh. Manual setup required."
`;

  return `${scriptPreamble(`Install ${slug} plugin for ${targetConfig.name}`)}
${scriptValidateKey(targetConfig.configVar, usageUrl)}

# --- Setup directories ---
SETTINGS_DIR_RAW="${targetConfig.settingsDir}"
${scriptExpandTilde("SETTINGS_DIR_RAW")}
SETTINGS_DIR="\$SETTINGS_DIR_RAW"
PLUGINS_PARENT="\${SETTINGS_DIR}/plugins"
PLUGIN_DIR="\${PLUGINS_PARENT}/${slug}"
GATEWAY_ORIGIN="${gatewayOrigin}"
PLUGIN_SLUG="${slug}"
# Plugin source is installed alongside the plugin dir on the client host.
PLUGIN_SRC_DIR="\${PLUGIN_DIR}"

ensure_dir "\${SETTINGS_DIR}"
ensure_dir "\${PLUGINS_PARENT}"

echo "Installing ${slug} plugin for ${targetConfig.name}..."
echo "  Target settings: \${SETTINGS_DIR}"
echo "  Plugin dir:      \${PLUGIN_DIR}"

# --- Download plugin source bundle from gateway ---
if ! has_command curl; then
  echo "Error: curl is required to download the plugin bundle." >&2
  exit 1
fi
if ! has_command tar; then
  echo "Error: tar is required to extract the plugin bundle." >&2
  exit 1
fi

BUNDLE_URL="\${GATEWAY_ORIGIN}/api/plugins/bundle.tar.gz?slug=\${PLUGIN_SLUG}"
TMPTAR="\$(mktemp -t plugin-${slug}.XXXXXX)"
trap 'rm -f "\$TMPTAR"' EXIT
echo "  Downloading plugin source from \${BUNDLE_URL}..."
if ! curl -fsSL "\$BUNDLE_URL" -o "\$TMPTAR"; then
  echo "Error: failed to download plugin bundle." >&2
  exit 1
fi

# Clean-install: archive root is "${slug}/", extract into plugins/ to (re)create PLUGIN_DIR.
rm -rf "\${PLUGIN_DIR}"
if ! tar -xzf "\$TMPTAR" -C "\${PLUGINS_PARENT}"; then
  echo "Error: failed to extract plugin bundle." >&2
  exit 1
fi
echo "  Plugin source extracted to \${PLUGIN_DIR}"

# --- Download PLUGIN.md with install annotations (overwrites the one from the bundle) ---
if ORIGINAL_CONTENT=\$(curl -fsSL "\${GATEWAY_ORIGIN}/api/plugins/PLUGIN.md?slug=\${PLUGIN_SLUG}"); then
  CONTENT=\$(echo "\$ORIGINAL_CONTENT" | sed -e '/^---\$/,/^---\$/d')
  INSTALLED_AT=\$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  cat > "\${PLUGIN_DIR}/PLUGIN.md" << PLUGIN_EOF
---
name: ${slug}
target_platform: ${targetConfig.name}
installed_at: \${INSTALLED_AT}
---

\${CONTENT}
PLUGIN_EOF
  echo "  PLUGIN.md written to \${PLUGIN_DIR}/PLUGIN.md"
fi
${embeddedInstall}

echo ""
echo "${slug} plugin installed successfully!"
echo ""
echo "  Plugin dir:      \${PLUGIN_DIR}"
echo "  Settings dir:    \${SETTINGS_DIR}"
echo "  LitellmCTL URL:  \${GATEWAY_ORIGIN}"
`;
}

export function buildUninstallScript(
  slug: string,
  targetConfig: PluginTargetConfig,
  _gatewayOrigin: string,
  uninstallContent: string | null,
): string {
  const uninstallBody = uninstallContent
    ? `
# --- Run embedded uninstall.sh ---
export PLUGIN_DIR="\${PLUGIN_DIR}"
export SETTINGS_DIR="\${SETTINGS_DIR}"
export PLUGIN_SLUG="\${PLUGIN_SLUG}"
# --- Embedded uninstall.sh starts below ---
${uninstallContent}
# --- End of embedded uninstall.sh ---`
    : `
# --- Generic uninstall (no uninstall.sh found) ---
if [ -d "\${PLUGIN_DIR}" ]; then
  rm -rf "\${PLUGIN_DIR}"
  echo "  Removed plugin directory: \${PLUGIN_DIR}"
fi
echo ""
echo "${slug} plugin uninstalled."`;

  return `${scriptPreamble(`Uninstall ${slug} plugin for ${targetConfig.name}`)}

# --- Setup directories ---
SETTINGS_DIR_RAW="${targetConfig.settingsDir}"
${scriptExpandTilde("SETTINGS_DIR_RAW")}
SETTINGS_DIR="\$SETTINGS_DIR_RAW"
PLUGIN_DIR="\${SETTINGS_DIR}/plugins/${slug}"
PLUGIN_SLUG="${slug}"

echo "Uninstalling ${slug} plugin for ${targetConfig.name}..."
${uninstallBody}
`;
}

export { PLUGINS_DIR, PLUGIN_MANIFEST };
