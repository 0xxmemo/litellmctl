// Mutable live bindings — set once at startup via initConfig()
export let LITELLM_URL = "http://localhost:4040";
export let LITELLM_AUTH = "";
export let CONFIG_PATH = "";
export let PORT = 14041;

/**
 * Strip trailing slashes and a trailing /v1 so callers never produce /v1/v1/... when
 * LITELLM_URL is misconfigured as e.g. https://host/v1.
 */
export function normalizeLitellmBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u.endsWith("/v1")) {
    u = u.slice(0, -3).replace(/\/+$/, "");
  }
  return u;
}

export function initConfig(litellmUrl: string, masterKey: string, configPath: string, port: number) {
  LITELLM_URL = normalizeLitellmBaseUrl(litellmUrl);
  LITELLM_AUTH = `Bearer ${masterKey}`;
  CONFIG_PATH = configPath;
  PORT = port;
}
