import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import { apiKeys, validatedUsers, usageLogs, requireAuth, requireUser, calcCost } from "../lib/db";
import { extractProvider } from "../lib/models";

// GET /api/dashboard/global-stats — requireAuth (any authenticated user incl. guests)
async function globalStatsHandler(req: Request) {
  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const tokensExpr = { $add: [{ $ifNull: ["$tokens", 0] }, { $ifNull: ["$totalTokens", 0] }] };

    // All queries in parallel — DB, LiteLLM spend, and both aggregations
    const [users, keys, spendResult, modelAgg, usageByEmail] = await Promise.all([
      validatedUsers.find({}, { projection: { email: 1, role: 1 } }).toArray(),
      apiKeys.find({ revoked: false }, { projection: { email: 1, keyHash: 1 } }).toArray(),
      fetch(`${LITELLM_URL}/global/spend`, {
        headers: { Authorization: LITELLM_AUTH },
        signal: AbortSignal.timeout(3000),
      }).then(r => r.ok ? r.json() : null).catch(() => null),
      usageLogs.aggregate([
        { $group: {
          _id: "$model",
          requests: { $sum: 1 },
          tokens: { $sum: tokensExpr },
          promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
          completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
        }},
        { $sort: { tokens: -1 } },
      ], { maxTimeMS: 8000 }).toArray(),
      usageLogs.aggregate([
        { $group: {
          _id: "$email",
          requests: { $sum: 1 },
          tokens: { $sum: tokensExpr },
        }},
        { $sort: { requests: -1 } },
      ], { maxTimeMS: 8000 }).toArray(),
    ]);

    const totalTokensAgg = modelAgg.reduce((s: number, r: any) => s + Number(r.tokens || 0), 0);
    const totalRequests = modelAgg.reduce((s: number, r: any) => s + Number(r.requests || 0), 0);

    let calculatedSpend = 0;
    const modelUsage = modelAgg.map((r: any) => {
      const tok = Number(r.tokens || 0);
      const modelSpend = calcCost(r._id, Number(r.promptTokens || 0), Number(r.completionTokens || 0));
      calculatedSpend += modelSpend;
      return {
        model_name: r._id || "unknown",
        requests: Number(r.requests || 0),
        tokens: tok,
        spend: modelSpend,
        percentage: totalTokensAgg > 0 ? ((tok / totalTokensAgg) * 100).toFixed(1) : "0.0",
      };
    });

    const totalSpend = spendResult?.spend || spendResult?.total_spend || calculatedSpend;

    // Build top users
    const userKeyMap: Record<string, number> = {};
    for (const k of keys) {
      if (k.email) userKeyMap[k.email] = (userKeyMap[k.email] || 0) + 1;
    }
    const emailUsageMap: Record<string, { requests: number; tokens: number }> = {};
    for (const row of usageByEmail) {
      if (row._id) emailUsageMap[row._id] = { requests: Number(row.requests || 0), tokens: Number(row.tokens || 0) };
    }
    const topUsers = users
      .filter((u: any) => u.email)
      .map((u: any) => {
        const usage = emailUsageMap[u.email] || { requests: 0, tokens: 0 };
        return { email: u.email, role: u.role || "user", requests: usage.requests, tokens: usage.tokens, spend: 0, keys: userKeyMap[u.email] || 0 };
      })
      .filter((u: any) => u.keys > 0 || u.requests > 0)
      .sort((a: any, b: any) => (b.requests - a.requests) || (b.keys - a.keys));

    return Response.json({ totalUsers: users.length, activeKeys: keys.length, totalSpend, totalRequests, totalTokens: totalTokensAgg, modelUsage, topUsers });
  } catch (err) {
    console.error("global-stats error:", (err as Error).message);
    return Response.json({ error: "Failed to fetch global stats" }, { status: 500 });
  }
}

// GET /api/dashboard/user-stats — requireUser (not guest)
async function userStatsHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const userKeys = await apiKeys.find({ email: auth.email, revoked: false }).toArray();
    const keyHashes = userKeys.map((k: any) => k.keyHash).filter(Boolean);
    const matchClause = keyHashes.length
      ? { $or: [{ email: auth.email }, { apiKeyHash: { $in: keyHashes } }] }
      : { email: auth.email };

    const tokensExpr = { $add: [{ $ifNull: ["$tokens", 0] }, { $ifNull: ["$totalTokens", 0] }] };

    const [totals] = await usageLogs.aggregate([
      { $match: matchClause },
      { $group: {
        _id: null,
        requests: { $sum: 1 },
        tokens: { $sum: tokensExpr },
        promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
        completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
      }},
    ]).toArray();

    const modelBreakdown = await usageLogs.aggregate([
      { $match: matchClause },
      { $group: {
        _id: "$model",
        requests: { $sum: 1 },
        tokens: { $sum: tokensExpr },
        promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
        completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
        requestedAliases: { $addToSet: "$requestedModel" },
      }},
      { $sort: { tokens: -1 } },
    ]).toArray();

    const spend = modelBreakdown.reduce((sum: number, m: any) =>
      sum + calcCost(m._id, m.promptTokens || 0, m.completionTokens || 0), 0);
    const totalModelTokens = modelBreakdown.reduce((s: number, m: any) => s + m.tokens, 0);

    // Daily requests last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const dailyAgg = await usageLogs.aggregate([
      { $match: { ...matchClause, timestamp: { $gte: thirtyDaysAgo } } },
      { $group: {
        _id: { year: { $year: "$timestamp" }, month: { $month: "$timestamp" }, day: { $dayOfMonth: "$timestamp" } },
        requests: { $sum: 1 },
      }},
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]).toArray();

    const dailyMap: Record<string, number> = {};
    for (const e of dailyAgg) {
      const key = `${e._id.year}-${String(e._id.month).padStart(2,"0")}-${String(e._id.day).padStart(2,"0")}`;
      dailyMap[key] = e.requests;
    }

    const dailyRequests: { date: string; requests: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      dailyRequests.push({ date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), requests: dailyMap[key] || 0 });
    }

    return Response.json({
      requests: totals?.requests || 0,
      tokens: totals?.tokens || 0,
      promptTokens: totals?.promptTokens || 0,
      completionTokens: totals?.completionTokens || 0,
      spend,
      keys: userKeys.length,
      dailyRequests,
      modelUsage: modelBreakdown.map((m: any) => {
        const modelSpend = calcCost(m._id, m.promptTokens || 0, m.completionTokens || 0);
        const aliases = (m.requestedAliases || []).filter((a: string) => a && a !== m._id);
        return {
          model_name: m._id || "unknown",
          requested_aliases: aliases,
          requests: m.requests,
          tokens: m.tokens,
          cost: modelSpend,
          spend: modelSpend,
          percentage: totalModelTokens > 0 ? ((m.tokens / totalModelTokens) * 100).toFixed(1) : "0.0",
        };
      }),
    });
  } catch (err) {
    console.error("user-stats error:", (err as Error).message);
    return Response.json({ error: "Failed to fetch user stats" }, { status: 500 });
  }
}

// Helper: build match clause for a user's usage logs (email + API key hashes)
async function buildUserMatchClause(email: string) {
  const userKeys = await apiKeys
    .find({ email, revoked: false }, { projection: { keyHash: 1 } })
    .toArray();
  const keyHashes = userKeys.map((k: any) => k.keyHash).filter(Boolean);
  return keyHashes.length
    ? { $or: [{ email }, { apiKeyHash: { $in: keyHashes } }] }
    : { email };
}

// GET /api/overview/requests/grouped — requireAuth (any authenticated user incl. guests)
// Uses a cursor to stream only enough docs to fill the requested page of groups,
// instead of loading 10K docs into memory. Stops as soon as we have enough groups.
async function groupedRequestsHandler(req: Request) {
  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));
    const matchClause = await buildUserMatchClause(auth.email);

    // Target: we need (offset + pageSize) groups, plus 1 to know if there's more
    const targetGroups = (page - 1) * pageSize + pageSize + 1;

    // Cursor-based scan: project only needed fields, stop when we have enough groups
    const cursor = usageLogs.aggregate([
      { $match: matchClause },
      { $sort: { timestamp: -1 } },
      { $project: {
        _m: { $ifNull: ["$actualModel", "$model"] },
        endpoint: 1,
        promptTokens: { $ifNull: ["$promptTokens", 0] },
        completionTokens: { $ifNull: ["$completionTokens", 0] },
        tokens: { $add: [{ $ifNull: ["$tokens", 0] }, { $ifNull: ["$totalTokens", 0] }] },
        timestamp: 1,
      }},
    ], { maxTimeMS: 8000 });

    const groups: any[] = [];
    let groupCounter = 0;
    let docsRead = 0;

    for await (const r of cursor) {
      docsRead++;
      const model: string = r._m || "unknown";
      const ep: string | null = r.endpoint || null;
      const provider = extractProvider(model) || model;
      const groupKey = `${provider}|${model}|${ep}`;
      const tokens = r.tokens || 0;
      const cost = calcCost(model, r.promptTokens, r.completionTokens);
      const last = groups.length > 0 ? groups[groups.length - 1] : null;

      if (last && last._gk === groupKey) {
        last.count++;
        last.totalTokens += tokens;
        last.totalSpend += cost;
        last.lastTimestamp = r.timestamp;
      } else {
        // New group — check if we already have enough
        if (groups.length >= targetGroups) break;
        groups.push({
          id: `group-${++groupCounter}`,
          _gk: groupKey,
          provider, model, endpoint: ep,
          count: 1,
          totalTokens: tokens,
          totalSpend: cost,
          firstTimestamp: r.timestamp,
          lastTimestamp: r.timestamp,
          items: null,
        });
      }
    }
    await cursor.close();

    const hasMore = groups.length > (page - 1) * pageSize + pageSize;
    const offset = (page - 1) * pageSize;
    const pageGroups = groups.slice(offset, offset + pageSize).map(({ _gk, ...g }) => g);

    return Response.json({
      groups: pageGroups,
      pagination: {
        page,
        pageSize,
        totalGroups: groups.length - (hasMore ? 1 : 0),
        totalPages: Math.ceil((groups.length - (hasMore ? 1 : 0)) / pageSize),
        hasMore,
        totalRequests: docsRead,
      },
    });
  } catch (err) {
    console.error("grouped-requests error:", (err as Error).message);
    return Response.json({ error: "Failed to fetch grouped requests" }, { status: 500 });
  }
}

// GET /api/overview/requests/group-items — fetch individual items for an expanded group
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

    const matchClause = await buildUserMatchClause(auth.email);

    const fromDate = new Date(from);
    const toDate = new Date(to);
    fromDate.setSeconds(fromDate.getSeconds() - 1);
    toDate.setSeconds(toDate.getSeconds() + 1);

    // Single $and with all conditions — avoids conflicting top-level $or
    const items = await usageLogs.aggregate([
      { $match: {
        $and: [
          matchClause,
          { $or: [{ actualModel: model }, { model: model }] },
          ...(endpoint ? [{ endpoint }] : []),
          { timestamp: { $gte: fromDate, $lte: toDate } },
        ],
      }},
      { $sort: { timestamp: -1 } },
      { $limit: 100 },
      { $project: {
        requestedModel: { $ifNull: ["$requestedModel", null] },
        actualModel: { $ifNull: ["$actualModel", "$model"] },
        endpoint: { $ifNull: ["$endpoint", null] },
        promptTokens: { $ifNull: ["$promptTokens", 0] },
        completionTokens: { $ifNull: ["$completionTokens", 0] },
        totalTokens: { $ifNull: ["$tokens", 0] },
        timestamp: 1,
      }},
    ], { maxTimeMS: 6000 }).toArray();

    return Response.json({
      items: items.map((r: any) => ({
        ...r,
        _id: r._id.toString(),
        cost: calcCost(r.actualModel, r.promptTokens, r.completionTokens),
      })),
    });
  } catch (err) {
    console.error("group-items error:", (err as Error).message);
    return Response.json({ error: "Failed to fetch group items" }, { status: 500 });
  }
}

export const statsRoutes = {
  "/api/dashboard/global-stats":       { GET: globalStatsHandler },
  "/api/dashboard/user-stats":         { GET: userStatsHandler },
  "/api/overview/requests/grouped":    { GET: groupedRequestsHandler },
  "/api/overview/requests/group-items": { GET: groupItemsHandler },
};
