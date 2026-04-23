/**
 * Minimal test gateway for the Linux install-flow harness.
 *
 * Imports the real buildInstallScript / buildUninstallScript from lib/plugins
 * and lib/skills, and serves bundles from the real plugins/ and skills/ dirs
 * — so the bytes a curl-pipe-bash consumer receives here are byte-identical
 * to what the production gateway sends. We deliberately skip auth, config,
 * DB, etc., because the thing under test is the cross-shell behaviour of the
 * install command itself, not the rest of the gateway.
 */

import {
  scanPlugins,
  hasPluginComponent,
  getPluginComponent,
  buildInstallScript as buildPluginInstall,
  buildUninstallScript as buildPluginUninstall,
  PLUGIN_MANIFEST,
  PLUGINS_DIR,
  type PluginTargetConfig,
} from "../../gateway/lib/plugins";
import {
  scanSkills,
  hasSkillComponent,
  getSkillComponent,
  buildInstallScript as buildSkillInstall,
  buildUninstallScript as buildSkillUninstall,
  SKILL_MANIFEST,
  SKILLS_DIR,
  type SkillTargetConfig,
} from "../../gateway/lib/skills";
import { scriptResponse } from "../../gateway/lib/scripts";

const PORT = parseInt(process.env.HARNESS_PORT || "18041");

const PLUGIN_TARGET: PluginTargetConfig = {
  name: "Claude Code",
  settingsDir: "~/.claude",
  configVar: "LLM_GATEWAY_API_KEY",
};

const SKILL_TARGET: SkillTargetConfig = {
  name: "Claude Code",
  skillsDir: "~/.claude/skills",
  settingsDir: "~/.claude",
  configVar: "LLM_GATEWAY_API_KEY",
};

function originFromReq(req: Request): string {
  const url = new URL(req.url);
  return `http://${url.host}`;
}

function tarStream(root: string, slug: string): ReadableStream {
  const proc = Bun.spawn(
    ["tar", "-czf", "-", "-C", root, "--exclude=node_modules", "--exclude=.git", "--exclude=.DS_Store", slug],
    { stdout: "pipe", stderr: "inherit" },
  );
  return proc.stdout as ReadableStream;
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    // ── plugins ─────────────────────────────────────────────────────────────
    if (url.pathname === "/api/plugins") {
      return Response.json({ plugins: await scanPlugins() });
    }
    if (url.pathname === "/api/plugins/install.sh") {
      const slug = url.searchParams.get("slug") || "";
      if (!/^[a-z0-9-]+$/.test(slug)) return Response.json({ error: "bad slug" }, { status: 400 });
      if (!(await hasPluginComponent(slug, PLUGIN_MANIFEST))) return Response.json({ error: "not found" }, { status: 404 });
      const installContent = await getPluginComponent(slug, "install.sh");
      return scriptResponse(buildPluginInstall(slug, PLUGIN_TARGET, originFromReq(req), installContent));
    }
    if (url.pathname === "/api/plugins/uninstall.sh") {
      const slug = url.searchParams.get("slug") || "";
      if (!/^[a-z0-9-]+$/.test(slug)) return Response.json({ error: "bad slug" }, { status: 400 });
      const content = await getPluginComponent(slug, "uninstall.sh");
      return scriptResponse(buildPluginUninstall(slug, PLUGIN_TARGET, originFromReq(req), content));
    }
    if (url.pathname === "/api/plugins/PLUGIN.md") {
      const slug = url.searchParams.get("slug") || "";
      const content = await getPluginComponent(slug, PLUGIN_MANIFEST);
      if (!content) return Response.json({ error: "not found" }, { status: 404 });
      return new Response(content, { headers: { "Content-Type": "text/markdown" } });
    }
    if (url.pathname === "/api/plugins/bundle.tar.gz") {
      const slug = url.searchParams.get("slug") || "";
      return new Response(tarStream(PLUGINS_DIR, slug), {
        headers: { "Content-Type": "application/gzip" },
      });
    }

    // ── skills ──────────────────────────────────────────────────────────────
    if (url.pathname === "/api/skills") {
      return Response.json({ skills: await scanSkills() });
    }
    if (url.pathname === "/api/skills/install.sh") {
      const slug = url.searchParams.get("slug") || "";
      if (!/^[a-z0-9-]+$/.test(slug)) return Response.json({ error: "bad slug" }, { status: 400 });
      if (!(await hasSkillComponent(slug, SKILL_MANIFEST))) return Response.json({ error: "not found" }, { status: 404 });
      const installContent = await getSkillComponent(slug, "install.sh");
      return scriptResponse(buildSkillInstall(slug, SKILL_TARGET, originFromReq(req), installContent));
    }
    if (url.pathname === "/api/skills/uninstall.sh") {
      const slug = url.searchParams.get("slug") || "";
      if (!/^[a-z0-9-]+$/.test(slug)) return Response.json({ error: "bad slug" }, { status: 400 });
      const content = await getSkillComponent(slug, "uninstall.sh");
      return scriptResponse(buildSkillUninstall(slug, SKILL_TARGET, originFromReq(req), content));
    }
    if (url.pathname === "/api/skills/SKILL.md") {
      const slug = url.searchParams.get("slug") || "";
      const content = await getSkillComponent(slug, SKILL_MANIFEST);
      if (!content) return Response.json({ error: "not found" }, { status: 404 });
      return new Response(content, { headers: { "Content-Type": "text/markdown" } });
    }
    if (url.pathname === "/api/skills/bundle.tar.gz") {
      const slug = url.searchParams.get("slug") || "";
      return new Response(tarStream(SKILLS_DIR, slug), {
        headers: { "Content-Type": "application/gzip" },
      });
    }

    if (url.pathname === "/api/health") return new Response("ok");

    return new Response("not found", { status: 404 });
  },
});

console.log(`[harness] test gateway listening on http://0.0.0.0:${PORT}`);
