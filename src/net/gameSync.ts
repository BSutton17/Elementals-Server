import type { Server } from "socket.io";
import type { Match } from "../match/Match.js";
import { citizenCost, repairCost } from "../engine/purchases.js";

/**
 * Broadcasts the current authoritative game state to everyone in a match's room
 * (tickets #49, #60, #63). Sent on a fixed interval by the game loop and
 * immediately after any state-changing action (a purchase, a target change).
 * Each player carries their full economy (money, income, citizens, shield) plus
 * derived purchase costs (next citizen/repair cost) and their current `target`
 * (ticket #63) via the spread of the player state, so clients have everything to
 * render the economy and targeting. This sends the full current state each time;
 * field-level deltas are a later optimization.
 */
export function broadcastGameState(io: Server, match: Match): void {
  const state = match.gameState;
  if (!state) return;

  io.to(match.roomCode).emit("state:sync", {
    tick: state.tick,
    serverTime: Date.now(),
    players: state.getPlayers().map((p) => ({
      ...p,
      economy: { ...p.economy, nextCitizenCost: citizenCost(p) },
      castle: { ...p.castle, nextRepairCost: repairCost(p) },
    })),
    projectiles: [],
  });
}

/** Broadcasts the final result when a match ends (ticket #50). */
export function broadcastMatchEnded(io: Server, match: Match): void {
  io.to(match.roomCode).emit("match:ended", {
    winnerId: match.winnerId,
    players: match.gameState?.getPlayers() ?? [],
  });
}
