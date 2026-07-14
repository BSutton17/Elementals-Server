import { createServer } from "node:http";
import { Server } from "socket.io";
import { config } from "./config/index.js";
import { GameLoopManager } from "./engine/GameLoopManager.js";
import { MatchManager } from "./match/MatchManager.js";
import { registerConnectionHandlers } from "./net/connection.js";
import { ReconnectionManager } from "./net/ReconnectionManager.js";
import { broadcastGameState, broadcastGameEvents, broadcastMatchEnded } from "./net/gameSync.js";
import { createRequestListener } from "./net/health.js";
import { registerGlobalErrorHandlers } from "./util/errorHandler.js";
import { logger } from "./util/logger.js";

/**
 * Kingdoms authoritative server entry point.
 * Boots an HTTP server, attaches Socket.IO, and wires connection handling.
 * Gameplay systems are added by later tickets — this only prepares the server
 * to accept multiplayer events.
 */

// Install the last-resort error safety net before anything else runs.
registerGlobalErrorHandlers();

const httpServer = createServer(createRequestListener());

const io = new Server(httpServer, {
  cors: {
    origin: config.cors.origins,
    methods: ["GET", "POST"],
  },
});

const matches = new MatchManager();
const reconnection = new ReconnectionManager();
const gameLoops = new GameLoopManager(matches, {
  sync: (match) => broadcastGameState(io, match),
  syncEvents: (match, events) => broadcastGameEvents(io, match, events),
  onEnd: (match) => broadcastMatchEnded(io, match),
});
registerConnectionHandlers(io, {
  matches,
  reconnection,
  gameLoops,
  graceMs: config.reconnect.graceMs,
});

// Log low-level Socket.IO handshake/transport failures.
io.engine.on("connection_error", (error: { code: number; message: string }) => {
  logger.warn("Socket.IO connection error", {
    code: error.code,
    message: error.message,
  });
});

// Surface low-level server errors (e.g. the port already being in use).
httpServer.on("error", (error: NodeJS.ErrnoException) => {
  logger.error("HTTP server error", { code: error.code, message: error.message });
});

httpServer.listen(config.server.port, config.server.host, () => {
  logger.info("Server listening", {
    environment: config.environment,
    host: config.server.host,
    port: config.server.port,
    corsOrigins: config.cors.origins,
  });
});

// Graceful shutdown so in-flight sockets close cleanly.
const shutdown = (signal: string): void => {
  logger.info("Shutting down", { signal });
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
