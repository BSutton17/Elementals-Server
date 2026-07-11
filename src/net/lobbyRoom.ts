import type { Server } from "socket.io";
import type { Match } from "../match/Match.js";
import type { MatchManager } from "../match/MatchManager.js";
import { logger } from "../util/logger.js";

/** Why a player was removed from a match. */
export type PlayerRemovalReason = "left" | "disconnected";

/**
 * The single canonical lobby broadcast: sends the full updated match (player
 * list + room information) to every client in the room. Called on every lobby
 * change so clients can track lobby state from one event (`lobby:updated`).
 */
export function broadcastLobbyUpdate(io: Server, match: Match): void {
  io.to(match.roomCode).emit("lobby:updated", { match: match.serialize() });
}

/**
 * Removes a player from their match and applies the room-lifecycle side effects:
 *  - closes the room if it becomes empty,
 *  - reassigns the host if the host left,
 *  - broadcasts `lobby:playerLeft` (with the updated match and the removal
 *    reason) to the room.
 *
 * Shared by voluntary leaves (`"left"`) and reconnection-grace expiry
 * (`"disconnected"`) so the room-cleanup rules live in one place. Returns true
 * if a player was removed.
 */
export function removePlayerFromMatch(
  io: Server,
  matches: MatchManager,
  roomCode: string,
  playerId: string,
  reason: PlayerRemovalReason,
): boolean {
  const match = matches.getMatch(roomCode);
  if (!match || !match.hasPlayer(playerId)) return false;

  match.removePlayer(playerId);

  if (match.isEmpty()) {
    matches.removeMatch(roomCode);
    logger.info("Match closed (empty)", { roomCode });
  } else {
    if (match.hostId === playerId) {
      // Transfer host to another remaining player, preferring a connected one so
      // the role never lands on someone who is mid-reconnect.
      const players = match.getPlayers();
      const nextHost = players.find((p) => p.connected) ?? players[0];
      match.hostId = nextHost?.id ?? null;
    }
    // Thin semantic notification (who left, why) + canonical state broadcast.
    io.to(roomCode).emit("lobby:playerLeft", { playerId, reason });
    broadcastLobbyUpdate(io, match);
  }

  return true;
}
