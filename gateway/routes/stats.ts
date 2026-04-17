import { apiKeys, usageLogs, requireAuth, requireUser } from "../lib/db";
import { extractProvider } from "../lib/models";

// GET /api/stats/user — requireUser (not guest)
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
      keys: userKeys.length,
      dailyRequests,
      modelUsage: modelBreakdown.map((m: any) => {
        const aliases = (m.requestedAliases || []).filter((a: string) => a && a !== m._id);
        return {
          model_name: m._id || "unknown",
          requested_aliases: aliases,
          requests: m.requests,
          tokens: m.tokens,
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

// GET /api/stats/requests — requireAuth (any authenticated user incl. guests)
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
      const last = groups.length > 0 ? groups[groups.length - 1] : null;

      if (last && last._gk === groupKey) {
        last.count++;
        last.totalTokens += tokens;
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
    // knownGroups: how many distinct groups were found in this scan.
    // When hasMore=true this is a lower bound — the true total is unknown without a full scan.
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
    console.error("grouped-requests error:", (err as Error).message);
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
      })),
    });
  } catch (err) {
    console.error("group-items error:", (err as Error).message);
    return Response.json({ error: "Failed to fetch group items" }, { status: 500 });
  }
}

export const statsRoutes = {
  "/api/stats/user":            { GET: userStatsHandler },
  "/api/stats/requests":        { GET: groupedRequestsHandler },
  "/api/stats/requests/items":  { GET: groupItemsHandler },
};
