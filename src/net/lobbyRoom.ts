import type { Server } from "socket.io";
import type { Match } from "../match/Match.js";
import type { MatchManager } from "../match/MatchManager.js";
import { logger } from "../util/logger.js";
import { eliminatePlayer } from "../engine/elimination.js";
import { resolveWinner } from "../engine/winConditions.js";

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
  onRosterChanged?: (match: Match) => void,
): boolean {
  const match = matches.getMatch(roomCode);
  if (!match || !match.hasPlayer(playerId)) return false;

  // ⚠️ LEAVING AN ACTIVE MATCH IS AN ELIMINATION, not just a roster change.
  //
  // `removePlayer` deletes from the LOBBY roster; the win condition counts
  // `state.getPlayers().filter(p => !p.eliminated)` in the GAME STATE, which it
  // does not touch. So a player who disconnected stayed alive in the game
  // forever: in a duel the survivor count never fell to one, the match never
  // ended, and nobody ever saw a victory screen.
  //
  // Run through `eliminatePlayer` rather than setting the flag, because leaving
  // has the same consequences as dying — statuses and cooldowns stop applying,
  // and anyone aiming at the departed kingdom is freed to retarget without
  // waiting out the switch timer.
  const state = match.gameState;
  const leaver = state?.getPlayer(playerId);
  if (match.phase === "active" && state && leaver && !leaver.eliminated) {
    eliminatePlayer(state, leaver, match.tick);

    // And the removal may have decided the match. Nothing else will notice:
    // the tick loop stops once the room is torn down, and for the LAST
    // disconnect there may be no further tick at all.
    const outcome = resolveWinner(state);
    if (outcome.ended && match.phase === "active") {
      match.end(outcome.winnerId);
      if (state.events.enabled) {
        state.events.emit({ type: "matchEnded", tick: match.tick, winnerId: outcome.winnerId });
      }
      io.to(roomCode).emit("match:ended", { winnerId: outcome.winnerId });
      logger.info("Match ended by disconnect", { roomCode, winnerId: outcome.winnerId });
    }
  }

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
    // A public room whose last person has gone starts its ten-second fuse here.
    // Bots do not count as company: a room auto-filled with seven of them would
    // otherwise look occupied forever and keep being offered to real players.
    onRosterChanged?.(match);
  }

  return true;
}
