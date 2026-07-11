import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../util/logger.js";

/** Paths that answer the health check. */
const HEALTH_PATHS = new Set(["/health", "/healthz", "/"]);

/**
 * Creates the Node HTTP request listener for non-Socket.IO traffic.
 *
 * Socket.IO handles its own path (`/socket.io/`) and lets everything else fall
 * through to this listener. It serves a lightweight health check confirming the
 * server is online and accepting requests; all other routes return 404.
 */
export function createRequestListener() {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && HEALTH_PATHS.has(path)) {
      logger.debug("Health check", { path });
      const body = JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
  };
}
