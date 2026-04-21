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

// Temporal-proximity grouping: two rows with the same (provider|model|endpoint)
// key merge into one group as long as the gap between them is within the
// proximity window — even if rows with *different* keys appeared in between.
// This matches the UX intent that the list should show one row per "session of
// activity" per model, not a new stack every time the caller briefly hops to
// another model.
//
// 60 min is a session-shaped window: quick prompts back-to-back, thinking +
// typing, and even a short context-switch all live in the same bucket. Gaps
// bigger than that (lunch, overnight) correctly split the session. Tunable
// per-request via ?proximity=<N>m|<N>h (minutes/hours) for ad-hoc views.
const GROUP_PROXIMITY_DEFAULT_MS = 60 * 60 * 1000;
const GROUP_PROXIMITY_MIN_MS = 60 * 1000;          // 1 min
const GROUP_PROXIMITY_MAX_MS = 24 * 60 * 60 * 1000; // 24 h

// Upper bound on how far back we'll scan when the top-N groups are still
// absorbing rows. Prevents a user with millions of closely-spaced rows from
// pinning the event loop. In practice the break-when-done condition fires
// well before this.
const GROUP_SCAN_BUDGET = 5000;

/** Parse `?proximity=30m` / `90m` / `2h` / `45` (bare = minutes). */
function parseProximityMs(raw: string | null): number {
  if (!raw) return GROUP_PROXIMITY_DEFAULT_MS;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return GROUP_PROXIMITY_DEFAULT_MS;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "m").toLowerCase();
  const ms =
    unit === "ms" ? n :
    unit === "s"  ? n * 1000 :
    unit === "h"  ? n * 60 * 60 * 1000 :
                    n * 60 * 1000;
  return Math.max(GROUP_PROXIMITY_MIN_MS, Math.min(GROUP_PROXIMITY_MAX_MS, Math.round(ms)));
}

interface OpenGroup {
  id: string;
  _gk: string;
  _lastMs: number; // timestamp (ms) of this group's oldest absorbed row
  provider: string;
  model: string;
  endpoint: string | null;
  count: number;
  totalTokens: number;
  firstTimestamp: string;
  lastTimestamp: string;
  items: null;
}

// GET /api/stats/requests — requireAuth (any authenticated user incl. guests)
// Streams rows in timestamp-desc order and groups same-(provider|model|endpoint)
// rows that fall within GROUP_PROXIMITY_MS of the group's oldest item so far.
// Stops once (offset + pageSize + 1) groups are known AND no still-open group
// could absorb further rows.
async function groupedRequestsHandler(req: Request) {
  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));
    const proximityMs = parseProximityMs(url.searchParams.get("proximity"));

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

    const groups: OpenGroup[] = [];
    // Groups currently eligible to absorb further (older) rows. Keyed by
    // groupKey so same-key rows merge regardless of intervening different-key
    // rows. Entries are evicted when the next row is older than
    // g._lastMs - GROUP_PROXIMITY_MS (i.e. the gap exceeds proximity).
    const active = new Map<string, OpenGroup>();
    let groupCounter = 0;
    let docsRead = 0;

    for (const r of iter) {
      docsRead++;
      if (docsRead > GROUP_SCAN_BUDGET) break;

      const ts: number = r.timestamp;
      const model: string = r.m || "unknown";
      const ep: string | null = r.endpoint || null;
      const provider = extractProvider(model) || model;
      const groupKey = `${provider}|${model}|${ep}`;
      const tokens = r.tokens || 0;

      // Seal any open group whose oldest item is now too far from `ts` to
      // possibly absorb it — or any further (older) row.
      for (const [k, g] of active) {
        if (g._lastMs - ts > proximityMs) {
          active.delete(k);
        }
      }

      const existing = active.get(groupKey);
      if (existing) {
        existing.count++;
        existing.totalTokens += tokens;
        existing._lastMs = ts;
        existing.lastTimestamp = new Date(ts).toISOString();
        continue;
      }

      // Row didn't land in an open group of the same key.
      if (groups.length >= targetGroups) {
        // We already have enough groups for the requested page (+1 for
        // hasMore). Don't start new ones. If no open group remains, we're
        // done — further rows can't extend anything we care about.
        if (active.size === 0) break;
        continue;
      }

      const iso = new Date(ts).toISOString();
      const g: OpenGroup = {
        id: `group-${++groupCounter}`,
        _gk: groupKey,
        _lastMs: ts,
        provider, model, endpoint: ep,
        count: 1,
        totalTokens: tokens,
        firstTimestamp: iso,
        lastTimestamp: iso,
        items: null,
      };
      groups.push(g);
      active.set(groupKey, g);
    }

    const hasMore = groups.length > (page - 1) * pageSize + pageSize;
    const offset = (page - 1) * pageSize;
    const pageGroups = groups
      .slice(offset, offset + pageSize)
      .map(({ _gk, _lastMs, ...g }) => g);
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
