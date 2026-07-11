import type { Server, Socket } from "socket.io";
import type { GameLoopManager } from "../engine/GameLoopManager.js";
import type { MatchManager } from "../match/MatchManager.js";
import type { ReconnectionManager } from "./ReconnectionManager.js";
import { registerLobbyHandlers } from "./lobbyHandlers.js";
import { registerMatchHandlers } from "./matchHandlers.js";
import { broadcastLobbyUpdate, removePlayerFromMatch } from "./lobbyRoom.js";
import { registerSessionHandlers } from "./sessionHandlers.js";
import { logger } from "../util/logger.js";

export interface ConnectionDeps {
  matches: MatchManager;
  reconnection: ReconnectionManager;
  gameLoops: GameLoopManager;
  /** Reconnection grace period in ms before a disconnected player is removed. */
  graceMs: number;
}

/**
 * Wires up the base connection lifecycle for every socket, and attaches the
 * feature-domain handlers (lobby, and match in later tickets). See
 * SOCKET_EVENTS.md for the full event contract.
 */
export function registerConnectionHandlers(io: Server, deps: ConnectionDeps): void {
  const { matches, reconnection, gameLoops, graceMs } = deps;

  io.on("connection", (socket: Socket) => {
    logger.info("Client connected", { socketId: socket.id });

    registerSessionHandlers(socket);
    registerLobbyHandlers(io, socket, { matches, reconnection, gameLoops });
    registerMatchHandlers(io, socket, { matches });

    socket.on("error", (error: Error) => {
      logger.error("Socket error", { socketId: socket.id, error: error.message });
    });

    socket.on("disconnect", (reason) => {
      logger.info("Client disconnected", { socketId: socket.id, reason });

      const { playerId, roomCode } = socket.data as {
        playerId?: string;
        roomCode?: string;
      };
      if (!roomCode || !playerId) return;

      const match = matches.getMatch(roomCode);
      const player = match?.getPlayer(playerId);
      if (!match || !player) return;

      // Mark the player disconnected but keep their seat reserved.
      player.connected = false;
      player.socketId = null;

      // Let the room see the disconnected state, then start the grace period.
      broadcastLobbyUpdate(io, match);

      reconnection.schedule(roomCode, playerId, graceMs, () => {
        // Remove only if they never reconnected during the grace window.
        const current = matches.getMatch(roomCode)?.getPlayer(playerId);
        if (current && !current.connected) {
          removePlayerFromMatch(io, matches, roomCode, playerId, "disconnected");
          logger.info("Player removed after reconnect grace expired", {
            roomCode,
            playerId,
          });
        }
      });
    });
  });
}
