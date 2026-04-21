/**
 * Server-side plugin registry — extension point for plugin-scoped HTTP routes.
 *
 * Each server-side plugin is a single module exporting a GatewayPlugin value:
 * a slug, some metadata, its own relative routes, and an optional migration
 * hook that runs once at startup. Routes mount automatically at
 * /api/plugins/<slug>/<relpath>. Adding a new plugin is one file in
 * gateway/plugins/ + one line in gateway/plugins/index.ts.
 *
 * NOTE: This is distinct from lib/plugins.ts, which handles the *client-side*
 * plugin install experience (PLUGIN.md, install.sh, bundle downloads).
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
export type PluginRouteHandler = (req: Request) => Promise<Response>;
export type PluginRouteMap = Partial<Record<HttpMethod, PluginRouteHandler>>;

export interface GatewayPlugin {
  /** URL slug. Routes mount under /api/plugins/<slug>/<relpath>. */
  slug: string;
  /** Human-readable name for the manifest / UI. */
  name: string;
  /** One-line description. */
  description: string;
  /**
   * Relative routes. Keys start with "/" and are joined onto
   * /api/plugins/<slug>. Example: "/jobs" → /api/plugins/claude-context/jobs.
   */
  routes: Record<string, PluginRouteMap>;
  /**
   * Optional DDL / backfill run once at gateway startup. sqlite is synchronous,
   * so migrations are plain functions — the registry invokes them during
   * connectDB() after the base schema is up.
   */
  migrate?: () => void;
}

/** Flatten every plugin's routes into the absolute-path shape Bun.serve expects. */
export function buildPluginRoutes(
  plugins: GatewayPlugin[],
): Record<string, PluginRouteMap> {
  const out: Record<string, PluginRouteMap> = {};
  for (const plugin of plugins) {
    for (const [relPath, handlers] of Object.entries(plugin.routes)) {
      const suffix = relPath.startsWith("/") ? relPath : `/${relPath}`;
      const fullPath = `/api/plugins/${plugin.slug}${suffix}`;
      if (out[fullPath]) {
        throw new Error(`Plugin route collision at ${fullPath}`);
      }
      out[fullPath] = handlers;
    }
  }
  return out;
}

/**
 * Run each plugin's migrate() hook. Errors are logged but non-fatal so one
 * broken plugin can't prevent the gateway from starting.
 */
export function runPluginMigrations(plugins: GatewayPlugin[]): void {
  for (const plugin of plugins) {
    if (!plugin.migrate) continue;
    try {
      plugin.migrate();
    } catch (err) {
      console.error(`[plugin-registry] ${plugin.slug} migration failed:`, err);
    }
  }
}
