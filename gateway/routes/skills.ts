/**
 * Skills API routes
 *
 * All skill installation logic is in lib/skills.ts - this file just handles HTTP routing.
 */

import {
  scanSkills,
  hasSkillComponent,
  getSkillComponent,
  buildInstallScript,
  buildUninstallScript,
  SKILL_MANIFEST,
} from "../lib/skills";
import { buildGatewayOrigin, scriptResponse } from "../lib/scripts";

// Target platforms for skill installation
const INSTALL_TARGETS = {
  "claude-code": {
    name: "Claude Code",
    skillsDir: "~/.claude/skills",
    configVar: "LLM_GATEWAY_API_KEY",
  },
} as const;

type InstallTarget = keyof typeof INSTALL_TARGETS;

/**
 * GET /api/skills — Return manifest of all available skills.
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
 * GET /api/skills/install.sh?slug=:slug — Return install script for a skill.
 */
async function getSkillInstallScript(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";
  const targetParam = url.searchParams.get("target") || "claude-code";
  const target = (targetParam as InstallTarget) in INSTALL_TARGETS
    ? (targetParam as InstallTarget)
    : "claude-code";

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid skill name" }, { status: 400 });
  }

  if (!await hasSkillComponent(slug, SKILL_MANIFEST)) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }

  const targetConfig = INSTALL_TARGETS[target];
  const gatewayOrigin = buildGatewayOrigin(req);
  const installContent = await getSkillComponent(slug, "install.sh");
  const script = buildInstallScript(slug, targetConfig, gatewayOrigin, installContent);
  return scriptResponse(script);
}

/**
 * GET /api/skills/SKILL.md?slug=:slug — Return raw SKILL.md content.
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
 * GET /api/skills/hook.sh?slug=:slug — Return raw hook.sh script.
 */
async function getHookScript(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid skill name" }, { status: 400 });
  }

  const content = await getSkillComponent(slug, "hook.sh");
  if (!content) {
    return Response.json({ error: "hook.sh not found for this skill" }, { status: 404 });
  }

  return new Response(content, {
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * GET /api/skills/uninstall.sh?slug=:slug — Return uninstall script for a skill.
 */
async function getSkillUninstallScript(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";
  const targetParam = url.searchParams.get("target") || "claude-code";
  const target = (targetParam as InstallTarget) in INSTALL_TARGETS
    ? (targetParam as InstallTarget)
    : "claude-code";

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "Invalid skill name" }, { status: 400 });
  }

  if (!await hasSkillComponent(slug, SKILL_MANIFEST)) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }

  const targetConfig = INSTALL_TARGETS[target];
  const gatewayOrigin = buildGatewayOrigin(req);
  const uninstallContent = await getSkillComponent(slug, "uninstall.sh");
  const script = buildUninstallScript(slug, targetConfig, gatewayOrigin, uninstallContent);
  return scriptResponse(script);
}

export const skillsRoutes = {
  "/api/skills": { GET: getSkillsHandler },
  "/api/skills/targets": { GET: getInstallTargetsHandler },
  "/api/skills/install.sh": { GET: getSkillInstallScript },
  "/api/skills/uninstall.sh": { GET: getSkillUninstallScript },
  "/api/skills/SKILL.md": { GET: getSkillManifest },
  "/api/skills/hook.sh": { GET: getHookScript },
};
