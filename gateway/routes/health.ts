import { db } from "../lib/db";

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

/** MongoDB ping probe. */
async function dbProbe(): Promise<boolean> {
  try {
    if (!db) return false;
    await db.admin().ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Health check with comprehensive feature detection.
 * All probes run in parallel — worst-case latency is ~1s, not 5s.
 */
async function healthHandler() {
  const searxngPort = parseInt(process.env.SEARXNG_PORT || "8888");
  const embeddingPort = parseInt(process.env.LOCAL_EMBEDDING_API_BASE?.split(":").pop() || "11434");
  const transcriptionPort = parseInt(process.env.LOCAL_TRANSCRIPTION_API_BASE?.split(":").pop() || "10300");
  const protonHost = process.env.GATEWAY_PROTON_SMTP_HOST || "127.0.0.1";
  const protonPort = parseInt(process.env.GATEWAY_PROTON_SMTP_PORT || "1025");

  const [search, embedding, transcription, proton, database] = await Promise.all([
    httpProbe(`http://localhost:${searxngPort}/`),
    httpProbe(`http://localhost:${embeddingPort}/api/tags`),
    httpProbe(`http://localhost:${transcriptionPort}/api/health`),
    tcpProbe(protonHost, protonPort),
    dbProbe(),
  ]);

  return Response.json({
    status: "ok",
    uptime: process.uptime(),
    features: { search, embedding, transcription, proton, database },
  });
}

export const healthRoutes = {
  "/api/health": { GET: healthHandler },
};
