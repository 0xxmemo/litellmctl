/**
 * Centralized feature-availability checks shared by /api/health and any
 * surface that gates behavior on a feature being usable (e.g. the MCP
 * endpoint hiding tools when their upstream isn't configured).
 *
 * Keep these pure and cheap — they run on every /api/health hit.
 */

function isRealEnv(name: string): boolean {
  const v = (process.env[name] || "").trim();
  if (!v) return false;
  // Matches the placeholders in .env.example ("your-google-ai-key", etc.).
  if (v.startsWith("your-")) return false;
  return true;
}

/**
 * Image generation via the `google/nano-banana*` models is usable iff a real
 * GOOGLE_AI_API_KEY is in the environment. We intentionally do NOT call Google
 * here — that would make health checks slow and cost money on every hit.
 */
export function imageGenerationHealthy(): boolean {
  return isRealEnv("GOOGLE_AI_API_KEY");
}
