/**
 * Skills API routes — mirrors plugins.ts: one bundle endpoint per skill instead
 * of one endpoint per file type. The install script streams the whole skill
 * directory as a tarball and extracts it on the target host.
 *
 * All skill installation logic lives in lib/skills.ts.
 */

import {
  scanSkills,
  hasSkillComponent,
  getSkillComponent,
  buildInstallScript,
  buildUninstallScript,
  SKILL_MANIFEST,
  SKILLS_DIR,
  type SkillTargetConfig,
} from "../lib/skills";
import { buildGatewayOrigin, scriptResponse } from "../lib/scripts";

const INSTALL_TARGETS: Record<string, SkillTargetConfig> = {
  "claude-code": {
    name: "Claude Code",
    skillsDir: "~/.claude/skills",
    settingsDir: "~/.claude",
    // TODO: LITELLMCTL_API_KEY — keep LLM_GATEWAY_API_KEY for existing deployments.
    configVar: "LLM_GATEWAY_API_KEY",
  },
};

function getTarget(param: string | null): SkillTargetConfig {
  const key = param && param in INSTALL_TARGETS ? param : "claude-code";
  return INSTALL_TARGETS[key];
}

/**
 * GET /api/skills — manifest of all available skills.
 */
async function getSkillsHandler(): Promise<Response> {
  const skills = await scanSkills();
  return Response.json({ skills });
}

/**
 * GET /api/skills/targets — available install targets.
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
 * GET /api/skills/install.sh?slug=:slug — install script for a skill.
 */
async function getSkillInstallScript(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid skill name" }, { status: 400 });
  }
  if (!(await hasSkillComponent(slug, SKILL_MANIFEST))) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }

  const target = getTarget(url.searchParams.get("target"));
  const gatewayOrigin = buildGatewayOrigin(req);
  const installContent = await getSkillComponent(slug, "install.sh");
  const script = buildInstallScript(slug, target, gatewayOrigin, installContent);
  return scriptResponse(script);
}

/**
 * GET /api/skills/uninstall.sh?slug=:slug — uninstall script for a skill.
 */
async function getSkillUninstallScript(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid skill name" }, { status: 400 });
  }
  if (!(await hasSkillComponent(slug, SKILL_MANIFEST))) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }

  const target = getTarget(url.searchParams.get("target"));
  const gatewayOrigin = buildGatewayOrigin(req);
  const uninstallContent = await getSkillComponent(slug, "uninstall.sh");
  const script = buildUninstallScript(slug, target, gatewayOrigin, uninstallContent);
  return scriptResponse(script);
}

/**
 * GET /api/skills/SKILL.md?slug=:slug — raw SKILL.md content.
 *
 * Kept alongside the tarball so the installer can regenerate SKILL.md with
 * install-time frontmatter (installed_at, target_platform) — same pattern
 * plugins use for PLUGIN.md.
 */
async function getSkillManifest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid skill name" }, { status: 400 });
  }

  const content = await getSkillComponent(slug, SKILL_MANIFEST);
  if (!content) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }

  return new Response(content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * GET /api/skills/bundle.tar.gz?slug=:slug — streamed gzipped tarball of the
 * entire skill directory. Archive root is `<slug>/`, so the installer can
 * `tar -xzf` into the parent skills dir to (re)create `<slug>/` cleanly.
 */
async function getSkillBundle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid skill name" }, { status: 400 });
  }
  if (!(await hasSkillComponent(slug, SKILL_MANIFEST))) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }

  const proc = Bun.spawn(
    [
      "tar",
      "-czf", "-",
      "-C", SKILLS_DIR,
      "--exclude=node_modules",
      "--exclude=.git",
      "--exclude=.DS_Store",
      slug,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );

  return new Response(proc.stdout as ReadableStream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${slug}.tar.gz"`,
      "Cache-Control": "no-cache",
    },
  });
}

export const skillsRoutes = {
  "/api/skills": { GET: getSkillsHandler },
  "/api/skills/targets": { GET: getInstallTargetsHandler },
  "/api/skills/install.sh": { GET: getSkillInstallScript },
  "/api/skills/uninstall.sh": { GET: getSkillUninstallScript },
  "/api/skills/SKILL.md": { GET: getSkillManifest },
  "/api/skills/bundle.tar.gz": { GET: getSkillBundle },
};
