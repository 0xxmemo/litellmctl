import { db, requireAuth, requireUser, listUserKeyHashes } from "../lib/db";
import { errorMessage } from "../lib/errors";
import { extractProvider } from "../lib/models";

// Build SQL WHERE clause + bindings matching a user's own email OR one of their API key hashes.
function buildUserMatch(email: string, keyHashes: string[]): { where: string; params: any[] } {
  if (keyHashes.length === 0) {
    return { where: "email = ?", params: [email] };
  }
  const placeholders = keyHashes.map(() => "?").join(",");
  return {
    where: `(email = ? OR api_key_hash IN (${placeholders}))`,
    params: [email, ...keyHashes],
  };
}

// GET /api/stats/user — requireUser (not guest)
async function userStatsHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const keyHashes = listUserKeyHashes(auth.email);
    const m = buildUserMatch(auth.email, keyHashes);

    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS requests,
           COALESCE(SUM(tokens), 0) AS tokens,
           COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
           COALESCE(SUM(completion_tokens), 0) AS completionTokens
         FROM usage_logs WHERE ${m.where}`,
      )
      .get(...m.params) as any;

    const modelRows = db
      .prepare(
        `SELECT
           model,
           COUNT(*) AS requests,
           COALESCE(SUM(tokens), 0) AS tokens,
           COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
           COALESCE(SUM(completion_tokens), 0) AS completionTokens
         FROM usage_logs
         WHERE ${m.where}
         GROUP BY model
         ORDER BY tokens DESC`,
      )
      .all(...m.params) as any[];

    // Requested alias expansion per model
    const aliasStmt = db.prepare(
      `SELECT DISTINCT requested_model FROM usage_logs
       WHERE ${m.where} AND model = ? AND requested_model IS NOT NULL AND requested_model != model`,
    );
    const modelBreakdown = modelRows.map((r) => {
      const aliasRows = aliasStmt.all(...m.params, r.model) as { requested_model: string }[];
      return {
        ...r,
        requestedAliases: aliasRows.map((a) => a.requested_model).filter(Boolean),
      };
    });

    const totalModelTokens = modelBreakdown.reduce((s, m) => s + (m.tokens || 0), 0);

    // 30-day daily histogram (cutoff = 00:00 local 29 days ago)
    const thirtyStart = new Date();
    thirtyStart.setDate(thirtyStart.getDate() - 29);
    thirtyStart.setHours(0, 0, 0, 0);

    const dailyRows = db
      .prepare(
        `SELECT
           strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') AS day,
           COUNT(*) AS requests
         FROM usage_logs
         WHERE ${m.where} AND timestamp >= ?
         GROUP BY day`,
      )
      .all(...m.params, thirtyStart.getTime()) as { day: string; requests: number }[];

    const dailyMap: Record<string, number> = {};
    for (const r of dailyRows) dailyMap[r.day] = r.requests;

    const dailyRequests: { date: string; requests: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      dailyRequests.push({
        date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        requests: dailyMap[key] || 0,
      });
    }

    return Response.json({
      requests: totals?.requests || 0,
      tokens: totals?.tokens || 0,
      promptTokens: totals?.promptTokens || 0,
      completionTokens: totals?.completionTokens || 0,
      keys: keyHashes.length,
      dailyRequests,
      modelUsage: modelBreakdown.map((m) => ({
        model_name: m.model || "unknown",
        requested_aliases: m.requestedAliases,
        requests: m.requests,
        tokens: m.tokens,
        percentage: totalModelTokens > 0 ? ((m.tokens / totalModelTokens) * 100).toFixed(1) : "0.0",
      })),
    });
  } catch (err) {
    console.error("user-stats error:", errorMessage(err));
    return Response.json({ error: "Failed to fetch user stats" }, { status: 500 });
  }
}

// GET /api/stats/requests — requireAuth (any authenticated user incl. guests)
// Streams rows in timestamp-desc order and collects consecutive same-provider/model/endpoint
// runs into groups. Stops as soon as we have (offset + pageSize + 1) groups.
async function groupedRequestsHandler(req: Request) {
  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

    const keyHashes = listUserKeyHashes(auth.email);
    const m = buildUserMatch(auth.email, keyHashes);
    const targetGroups = (page - 1) * pageSize + pageSize + 1;

    const iter = db
      .prepare(
        `SELECT
           COALESCE(actual_model, model) AS m,
           endpoint,
           prompt_tokens AS promptTokens,
           completion_tokens AS completionTokens,
           tokens,
           timestamp
         FROM usage_logs
         WHERE ${m.where}
         ORDER BY timestamp DESC`,
      )
      .iterate(...m.params) as IterableIterator<any>;

    const groups: any[] = [];
    let groupCounter = 0;
    let docsRead = 0;

    for (const r of iter) {
      docsRead++;
      const model: string = r.m || "unknown";
      const ep: string | null = r.endpoint || null;
      const provider = extractProvider(model) || model;
      const groupKey = `${provider}|${model}|${ep}`;
      const tokens = r.tokens || 0;
      const last = groups.length > 0 ? groups[groups.length - 1] : null;

      if (last && last._gk === groupKey) {
        last.count++;
        last.totalTokens += tokens;
        last.lastTimestamp = new Date(r.timestamp).toISOString();
      } else {
        if (groups.length >= targetGroups) break;
        const ts = new Date(r.timestamp).toISOString();
        groups.push({
          id: `group-${++groupCounter}`,
          _gk: groupKey,
          provider, model, endpoint: ep,
          count: 1,
          totalTokens: tokens,
          firstTimestamp: ts,
          lastTimestamp: ts,
          items: null,
        });
      }
    }

    const hasMore = groups.length > (page - 1) * pageSize + pageSize;
    const offset = (page - 1) * pageSize;
    const pageGroups = groups.slice(offset, offset + pageSize).map(({ _gk, ...g }) => g);
    const knownGroups = groups.length - (hasMore ? 1 : 0);

    return Response.json({
      groups: pageGroups,
      pagination: {
        page,
        pageSize,
        totalGroups: knownGroups,
        hasMore,
        hasExactTotal: !hasMore,
        totalRequests: docsRead,
      },
    });
  } catch (err) {
    console.error("grouped-requests error:", errorMessage(err));
    return Response.json({ error: "Failed to fetch grouped requests" }, { status: 500 });
  }
}

// GET /api/stats/requests/items — fetch individual items for an expanded group
async function groupItemsHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(req.url);
    const model = url.searchParams.get("model");
    const endpoint = url.searchParams.get("endpoint");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    if (!model || !from || !to) {
      return Response.json({ error: "model, from, to are required" }, { status: 400 });
    }

    const keyHashes = listUserKeyHashes(auth.email);
    const m = buildUserMatch(auth.email, keyHashes);

    const fromMs = new Date(from).getTime() - 1000;
    const toMs = new Date(to).getTime() + 1000;

    const endpointClause = endpoint ? "AND endpoint = ?" : "";
    const params: any[] = [...m.params, model, model];
    if (endpoint) params.push(endpoint);
    params.push(fromMs, toMs);

    const rows = db
      .prepare(
        `SELECT
           id,
           requested_model AS requestedModel,
           COALESCE(actual_model, model) AS actualModel,
           endpoint,
           prompt_tokens AS promptTokens,
           completion_tokens AS completionTokens,
           tokens AS totalTokens,
           timestamp
         FROM usage_logs
         WHERE ${m.where}
           AND (actual_model = ? OR model = ?)
           ${endpointClause}
           AND timestamp BETWEEN ? AND ?
         ORDER BY timestamp DESC
         LIMIT 100`,
      )
      .all(...params) as any[];

    return Response.json({
      items: rows.map((r) => ({
        _id: String(r.id),
        requestedModel: r.requestedModel ?? null,
        actualModel: r.actualModel,
        endpoint: r.endpoint ?? null,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        totalTokens: r.totalTokens,
        timestamp: new Date(r.timestamp).toISOString(),
      })),
    });
  } catch (err) {
    console.error("group-items error:", errorMessage(err));
    return Response.json({ error: "Failed to fetch group items" }, { status: 500 });
  }
}

export const statsRoutes = {
  "/api/stats/user":            { GET: userStatsHandler },
  "/api/stats/requests":        { GET: groupedRequestsHandler },
  "/api/stats/requests/items":  { GET: groupItemsHandler },
};
