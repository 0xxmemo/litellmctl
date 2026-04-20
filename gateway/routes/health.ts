import { dbHealthy } from "../lib/db";
import { consoleEnabled } from "../lib/pty";

/** Try an HTTP probe, return true if response is ok within timeout. */
async function httpProbe(url: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** TCP port probe via net module, return true if connection succeeds. */
async function tcpProbe(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const net = require("net");
    const socket = net.createConnection(port, host);
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
      socket.on("connect", () => { clearTimeout(timer); socket.end(); resolve(true); });
      socket.on("error", () => { clearTimeout(timer); resolve(false); });
    });
  } catch {
    return false;
  }
}

/** SQLite availability probe. */
function dbProbe(): boolean {
  return dbHealthy();
}

/**
 * Health check with comprehensive feature detection.
 * All probes run in parallel — worst-case latency is ~1s, not 5s.
 */
async function healthHandler() {
  // Full URLs let sidecars be reached by hostname in docker compose, while
  // keeping `localhost:PORT` working on VPC installs. Never reconstruct from
  // a split(":") of a URL — it drops the scheme and hostname.
  const searxngUrl = process.env.SEARXNG_URL
    || `http://localhost:${process.env.SEARXNG_PORT || "8888"}`;
  const embeddingUrl = process.env.LOCAL_EMBEDDING_API_BASE || "http://localhost:11434";
  const transcriptionUrl = process.env.LOCAL_TRANSCRIPTION_API_BASE || "http://localhost:10300/v1";
  const protonHost = process.env.GATEWAY_PROTON_SMTP_HOST || "127.0.0.1";
  const protonPort = parseInt(process.env.GATEWAY_PROTON_SMTP_PORT || "1025");

  const [search, embedding, transcription, proton] = await Promise.all([
    httpProbe(`${searxngUrl.replace(/\/$/, "")}/`),
    httpProbe(`${embeddingUrl.replace(/\/$/, "")}/api/tags`),
    httpProbe(`${transcriptionUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "")}/api/health`),
    tcpProbe(protonHost, protonPort),
  ]);
  const database = dbProbe();

  return Response.json({
    status: "ok",
    uptime: process.uptime(),
    features: { search, embedding, transcription, proton, database, console: consoleEnabled() },
  });
}

export const healthRoutes = {
  "/api/health": { GET: healthHandler },
};
