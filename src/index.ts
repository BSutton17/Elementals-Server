import { createServer } from "node:http";
import { PublicLobbyManager } from "./net/PublicLobbyManager.js";
import { launchPublicMatch } from "./net/publicLobby.js";
import { broadcastLobbyUpdate } from "./net/lobbyRoom.js";
import { Server } from "socket.io";
import { config } from "./config/index.js";
import { GameLoopManager } from "./engine/GameLoopManager.js";
import { MatchManager } from "./match/MatchManager.js";
import { registerConnectionHandlers } from "./net/connection.js";
import { ReconnectionManager } from "./net/ReconnectionManager.js";
import { broadcastGameState, broadcastGameEvents, broadcastMatchEnded } from "./net/gameSync.js";
import { createRequestListener } from "./net/health.js";
import { readSessionToken } from "./auth/sessions.js";
import { closeDb, isDatabaseConfigured } from "./db/client.js";
import { getMatchIdentity } from "./db/accounts.js";
import { startAccountSweeper } from "./db/cleanup.js";
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

// Identity, resolved once at the handshake so every downstream handler can
// simply read `socket.data.accountId` instead of re-checking a token.
//
// ⚠️ THIS MIDDLEWARE MUST NEVER REJECT A CONNECTION. Kingdoms is a party game:
// somebody reads a room code aloud and their friends join in seconds. A guest
// with no token has to be able to do that, so a missing or expired token means
// "we do not know who this is", never "you may not play". Calling next(error)
// here would put a login wall in front of the entire game.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  const accountId = token ? readSessionToken(token) : null;

  socket.data.accountId = accountId; // null for guests
  socket.data.isGuest = accountId === null;
  socket.data.username = null;
  socket.data.level = null;
  socket.data.loadout = null;

  // ⚠️ next() FIRST, then the profile read. The username is wanted (a signed-in
  // player plays under it, not under whatever the client typed) but it lives in
  // the database, and awaiting a database inside the handshake would mean a slow
  // Postgres delays every connection and a hung one blocks the game entirely.
  //
  // Firing it afterwards costs nothing: the read lands in tens of milliseconds,
  // and the earliest a player can act is the seconds it takes them to click.
  // If it somehow has not arrived, the lobby falls back to the typed name.
  next();

  if (accountId) {
    logger.debug("Socket identified", { accountId, socketId: socket.id });
    void getMatchIdentity(accountId)
      .then((identity) => {
        socket.data.username = identity?.username ?? null;
        socket.data.level = identity?.level ?? null;
        socket.data.loadout = identity?.loadout ?? null;
      })
      .catch(() => {
        // A guest for naming and cosmetic purposes. Nothing else changes.
      });
  }
});

const matches = new MatchManager();
const reconnection = new ReconnectionManager();
const gameLoops = new GameLoopManager(matches, {
  sync: (match) => broadcastGameState(io, match),
  syncEvents: (match, events) => broadcastGameEvents(io, match, events),
  onEnd: (match) => broadcastMatchEnded(io, match),
});
// Public rooms have no host, so the server owns the two jobs a host would
// otherwise do: deciding when to start, and closing the room afterwards.
const publicLobbies = new PublicLobbyManager(matches, {
  startMatch: (match) => launchPublicMatch(io, gameLoops, match),
  broadcast: (match) => broadcastLobbyUpdate(io, match),
  closeRoom: (roomCode) => {
    gameLoops.stop(roomCode);
    matches.removeMatch(roomCode);
    logger.info("Closed empty public room", { roomCode });
  },
});

registerConnectionHandlers(io, {
  matches,
  reconnection,
  gameLoops,
  publicLobbies,
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

// Housekeeping: clear out throwaway accounts left by local sign-ins. Safe in
// production, where accounts never carry an expiry (see db/cleanup.ts).
const stopSweeper = startAccountSweeper();

httpServer.listen(config.server.port, config.server.host, () => {
  logger.info("Server listening", {
    environment: config.environment,
    host: config.server.host,
    port: config.server.port,
    corsOrigins: config.cors.origins,
    // Stated at boot, not on first use. A server started without DATABASE_URL
    // runs perfectly well and silently has no accounts - which is exactly the
    // kind of thing an operator should learn from the startup line rather than
    // from a player reporting that sign-in does nothing.
    accounts: isDatabaseConfigured() ? "enabled" : "disabled (no DATABASE_URL)",
  });
});

// Graceful shutdown so in-flight sockets close cleanly.
const shutdown = (signal: string): void => {
  logger.info("Shutting down", { signal });
  stopSweeper();
  io.close(() => {
    httpServer.close(() => {
      void closeDb().finally(() => process.exit(0));
    });
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
