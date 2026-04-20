/**
 * Plugins API routes (mirror of skills — but plugins register MCP servers).
 */

import * as path from "path";
import {
  scanPlugins,
  hasPluginComponent,
  getPluginComponent,
  buildInstallScript,
  buildUninstallScript,
  PLUGIN_MANIFEST,
  PLUGINS_DIR,
  type PluginTargetConfig,
} from "../lib/plugins";
import { buildGatewayOrigin, scriptResponse } from "../lib/scripts";

const INSTALL_TARGETS: Record<string, PluginTargetConfig> = {
  "claude-code": {
    name: "Claude Code",
    settingsDir: "~/.claude",
    configVar: "LLM_GATEWAY_API_KEY",
  },
};

function getTarget(param: string | null): PluginTargetConfig {
  const key = param && param in INSTALL_TARGETS ? param : "claude-code";
  return INSTALL_TARGETS[key];
}

async function getPluginsHandler(): Promise<Response> {
  const plugins = await scanPlugins();
  return Response.json({ plugins });
}

async function getTargetsHandler(): Promise<Response> {
  const targets = Object.entries(INSTALL_TARGETS).map(([key, value]) => ({
    id: key,
    name: value.name,
    settingsDir: value.settingsDir,
    configVar: value.configVar,
  }));
  return Response.json({ targets });
}

async function getPluginInstallScript(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid plugin slug" }, { status: 400 });
  }
  if (!(await hasPluginComponent(slug, PLUGIN_MANIFEST))) {
    return Response.json({ error: "Plugin not found" }, { status: 404 });
  }

  const target = getTarget(url.searchParams.get("target"));
  const gatewayOrigin = buildGatewayOrigin(req);
  const installContent = await getPluginComponent(slug, "install.sh");
  const pluginAbsoluteDir = path.join(PLUGINS_DIR, slug);
  const script = buildInstallScript(slug, target, gatewayOrigin, installContent, pluginAbsoluteDir);
  return scriptResponse(script);
}

async function getPluginUninstallScript(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid plugin slug" }, { status: 400 });
  }
  if (!(await hasPluginComponent(slug, PLUGIN_MANIFEST))) {
    return Response.json({ error: "Plugin not found" }, { status: 404 });
  }

  const target = getTarget(url.searchParams.get("target"));
  const gatewayOrigin = buildGatewayOrigin(req);
  const uninstallContent = await getPluginComponent(slug, "uninstall.sh");
  const script = buildUninstallScript(slug, target, gatewayOrigin, uninstallContent);
  return scriptResponse(script);
}

async function getPluginManifest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid plugin slug" }, { status: 400 });
  }
  const content = await getPluginComponent(slug, PLUGIN_MANIFEST);
  if (!content) return Response.json({ error: "Plugin not found" }, { status: 404 });
  return new Response(content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export const pluginsRoutes = {
  "/api/plugins": { GET: getPluginsHandler },
  "/api/plugins/targets": { GET: getTargetsHandler },
  "/api/plugins/install.sh": { GET: getPluginInstallScript },
  "/api/plugins/uninstall.sh": { GET: getPluginUninstallScript },
  "/api/plugins/PLUGIN.md": { GET: getPluginManifest },
};
