import { CONFIG_PATH } from "../lib/config";
import { validatedUsers, userProfileCache, requireUser } from "../lib/db";

// PUT /api/user/profile — requireUser (not guest)
async function userProfileHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const body = await req.json();
    const update: Record<string, string> = {};
    if (typeof body.name === "string") update.name = body.name.trim();
    if (typeof body.company === "string") update.company = body.company.trim();
    if (Object.keys(update).length > 0) {
      await validatedUsers.updateOne({ email: auth.email }, { $set: update });
      userProfileCache.delete(auth.email);
    }
    return Response.json({ success: true });
  } catch (err) {
    console.error("PUT /api/user/profile error:", (err as Error).message);
    return Response.json({ error: "Failed to update profile" }, { status: 500 });
  }
}

// GET /api/user/model-overrides — requireUser (not guest)
async function getUserModelOverridesHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const record = await validatedUsers.findOne({ email: auth.email }, { projection: { model_overrides: 1 } });
    return Response.json({ model_overrides: record?.model_overrides || {} });
  } catch (err) {
    console.error("GET /api/user/model-overrides error:", (err as Error).message);
    return Response.json({ error: "Failed to fetch model overrides" }, { status: 500 });
  }
}

// PUT /api/user/model-overrides — requireUser (not guest)
async function putUserModelOverridesHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const body = await req.json();
    const overrides: Record<string, string> = {};
    if (body && typeof body === "object") {
      for (const [k, v] of Object.entries(body)) {
        if (typeof k === "string" && typeof v === "string" && v.trim()) {
          overrides[k] = v.trim();
        }
      }
    }
    await validatedUsers.updateOne({ email: auth.email }, { $set: { model_overrides: overrides } });
    userProfileCache.delete(auth.email);
    return Response.json({ success: true, model_overrides: overrides });
  } catch (err) {
    console.error("PUT /api/user/model-overrides error:", (err as Error).message);
    return Response.json({ error: "Failed to update model overrides" }, { status: 500 });
  }
}

// GET /api/config/aliases — requireUser (not guest)
async function getConfigAliasesHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const yaml = await import("js-yaml");
    const file = Bun.file(CONFIG_PATH);
    if (await file.exists()) {
      const text = await file.text();
      const parsed = yaml.load(text) as any;
      const alias = parsed?.router_settings?.model_group_alias || parsed?.model_group_alias || {};
      return Response.json({ model_group_alias: alias });
    }
    return Response.json({ model_group_alias: {} });
  } catch {
    return Response.json({ model_group_alias: {} });
  }
}

export const userRoutes = {
  "/api/user/profile":         { PUT: userProfileHandler },
  "/api/user/model-overrides": { GET: getUserModelOverridesHandler, PUT: putUserModelOverridesHandler },
  "/api/config/aliases":       { GET: getConfigAliasesHandler },
};
