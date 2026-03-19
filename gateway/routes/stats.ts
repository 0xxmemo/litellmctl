import { LITELLM_URL, LITELLM_AUTH } from "../lib/config";
import { apiKeys, validatedUsers, usageLogs, getAuthenticatedUser, calcCost } from "../lib/db";

// GET /api/dashboard/global-stats — requiresApiKeyOrSession (any authenticated user incl. guests)
async function globalStatsHandler(req: Request) {
  const caller = await getAuthenticatedUser(req);
  if (!caller) return Response.json({ error: "Authentication required" }, { status: 401 });

  try {
    const [users, keys] = await Promise.all([
      validatedUsers.find({}).toArray(),
      apiKeys.find({ revoked: false }).toArray(),
    ]);

    // Try LiteLLM /global/spend
    let totalSpend = 0;
    try {
      const spendRes = await fetch(`${LITELLM_URL}/global/spend`, {
        headers: { Authorization: LITELLM_AUTH },
      });
      if (spendRes.ok) {
        const data = await spendRes.json();
        totalSpend = data.spend || data.total_spend || 0;
      }
    } catch {}

    // Model usage from MongoDB usage_logs
    // Handle both 'tokens' (reference) and 'totalTokens' (legacy field names)
    const tokensExpr = { $add: [{ $ifNull: ["$tokens", 0] }, { $ifNull: ["$totalTokens", 0] }] };
    const modelAgg = await usageLogs.aggregate([
      { $group: {
        _id: "$model",
        requests: { $sum: 1 },
        tokens: { $sum: tokensExpr },
        promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
        completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
      }},
      { $sort: { tokens: -1 } },
    ]).toArray();

    const totalTokensAgg = modelAgg.reduce((s: number, r: any) => s + Number(r.tokens || 0), 0);
    const totalRequests = modelAgg.reduce((s: number, r: any) => s + Number(r.requests || 0), 0);
    const totalTokens = totalTokensAgg;

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
    // Use LiteLLM spend if available, otherwise fall back to calculated
    if (totalSpend === 0) totalSpend = calculatedSpend;

    // Top users from usage_logs
    const userKeyMap: Record<string, any[]> = {};
    for (const k of keys) {
      if (k.email) {
        userKeyMap[k.email] = userKeyMap[k.email] || [];
        userKeyMap[k.email].push(k);
      }
    }

    let topUsers: any[] = [];
    try {
      const usageAgg = await usageLogs.aggregate([
        { $group: {
          _id: "$email",
          requests: { $sum: 1 },
          tokens: { $sum: tokensExpr },
        }},
        { $sort: { requests: -1 } },
      ]).toArray();

      const emailUsageMap: Record<string, { requests: number; tokens: number }> = {};
      for (const row of usageAgg) {
        if (row._id) emailUsageMap[row._id] = { requests: Number(row.requests || 0), tokens: Number(row.tokens || 0) };
      }

      topUsers = users
        .filter((u: any) => u.email)
        .map((u: any) => {
          const userKeys = userKeyMap[u.email] || [];
          const usage = emailUsageMap[u.email] || { requests: 0, tokens: 0 };
          return { email: u.email, role: u.role || "user", requests: usage.requests, tokens: usage.tokens, spend: 0, keys: userKeys.length };
        })
        .filter((u: any) => u.keys > 0 || u.requests > 0)
        .sort((a: any, b: any) => (b.requests - a.requests) || (b.keys - a.keys));
    } catch {}

    return Response.json({ totalUsers: users.length, activeKeys: keys.length, totalSpend, totalRequests, totalTokens, modelUsage, topUsers });
  } catch (err) {
    console.error("global-stats error:", (err as Error).message);
    return Response.json({ error: "Failed to fetch global stats" }, { status: 500 });
  }
}

// GET /api/dashboard/user-stats
async function userStatsHandler(req: Request) {
  const user = await getAuthenticatedUser(req);
  if (!user || user.role === "guest") {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  try {
    const userKeys = await apiKeys.find({ email: user.email, revoked: false }).toArray();
    const keyHashes = userKeys.map((k: any) => k.keyHash).filter(Boolean);
    const matchClause = keyHashes.length
      ? { $or: [{ email: user.email }, { apiKeyHash: { $in: keyHashes } }] }
      : { email: user.email };

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

// GET /api/overview/requests/grouped — requiresApiKeyOrSession (any authenticated user incl. guests)
async function groupedRequestsHandler(req: Request) {
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

    const userKeys = await apiKeys.find({ email: user.email, revoked: false }).toArray();
    const keyHashes = userKeys.map((k: any) => k.keyHash).filter(Boolean);
    const matchClause = keyHashes.length
      ? { $or: [{ email: user.email }, { apiKeyHash: { $in: keyHashes } }] }
      : { email: user.email };

    const [raw, totalRequests] = await Promise.all([
      usageLogs.find(matchClause).sort({ timestamp: -1 }).limit(10000).toArray(),
      usageLogs.countDocuments(matchClause),
    ]);

    // Group consecutive same model+endpoint requests
    const allGroups: any[] = [];
    let groupCounter = 0;
    for (const r of raw) {
      const model = r.actualModel || r.model || null;
      const endpoint = r.endpoint || null;
      const provider = model && model.includes("/") ? model.split("/")[0] : (model || "unknown");
      const groupKey = `${provider}|${model}|${endpoint}`;
      const cost = calcCost(model, r.promptTokens || 0, r.completionTokens || 0);
      const tokens = r.tokens || r.totalTokens || 0;
      const item = {
        _id: r._id.toString(),
        requestedModel: r.requestedModel || null,
        actualModel: model,
        endpoint,
        promptTokens: r.promptTokens || 0,
        completionTokens: r.completionTokens || 0,
        totalTokens: tokens,
        cost,
        timestamp: r.timestamp,
      };
      const lastGroup = allGroups.length > 0 ? allGroups[allGroups.length - 1] : null;
      if (lastGroup && lastGroup._groupKey === groupKey) {
        lastGroup.count += 1;
        lastGroup.totalTokens += tokens;
        lastGroup.totalSpend += cost;
        lastGroup.lastTimestamp = item.timestamp;
        lastGroup._itemIds.push(item._id);
      } else {
        groupCounter++;
        allGroups.push({
          id: `group-${groupCounter}`,
          _groupKey: groupKey,
          _itemIds: [item._id],
          provider,
          model,
          endpoint,
          count: 1,
          totalTokens: tokens,
          totalSpend: cost,
          firstTimestamp: item.timestamp,
          lastTimestamp: item.timestamp,
          items: null,
        });
      }
    }

    const totalGroups = allGroups.length;
    const totalPages = Math.ceil(totalGroups / pageSize);
    const offset = (page - 1) * pageSize;
    const pageGroups = allGroups.slice(offset, offset + pageSize).map(({ _groupKey, _itemIds, ...g }) => g);

    return Response.json({
      groups: pageGroups,
      pagination: { page, pageSize, totalGroups, totalPages, hasMore: page < totalPages, totalRequests },
    });
  } catch (err) {
    console.error("grouped-requests error:", (err as Error).message);
    return Response.json({ error: "Failed to fetch grouped requests" }, { status: 500 });
  }
}

export const statsRoutes = {
  "/api/dashboard/global-stats":    { GET: globalStatsHandler },
  "/api/dashboard/user-stats":      { GET: userStatsHandler },
  "/api/overview/requests/grouped": { GET: groupedRequestsHandler },
};
