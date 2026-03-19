import { requireUser } from "../lib/db";

/**
 * Search handler — proxies authenticated requests to SearXNG.
 * Requires authentication (session or API key).
 */
async function searchHandler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const port = parseInt(process.env.SEARXNG_PORT || "8888");
  const target = new URL(`http://localhost:${port}/search`);

  // Copy all query params from the request
  url.searchParams.forEach((v, k) => target.searchParams.set(k, v));

  // Force JSON format for consistent responses
  if (!target.searchParams.has("format")) {
    target.searchParams.set("format", "json");
  }

  try {
    const res = await fetch(target.toString(), {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return Response.json(
        { error: "Search engine error" },
        { status: res.status }
      );
    }

    return Response.json(await res.json());
  } catch {
    return Response.json(
      { error: "Search unavailable — is SearXNG running?" },
      { status: 503 }
    );
  }
}

export const searchRoutes = {
  "/api/search": { GET: searchHandler },
};
