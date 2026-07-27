import type { Server } from "socket.io";
import type { Match } from "../match/Match.js";
import type { PlayerState } from "../match/playerState.js";
import type { GameplayEvent } from "../engine/events.js";
import { citizenCost, repairCost, shieldCost } from "../engine/purchases.js";
import { resolveAbility } from "../engine/abilities.js";
import { ALL_ABILITIES } from "../data/abilitiesRegistry.js";
import { SHIELD } from "../data/balance.js";
import { param } from "../engine/parameters.js";

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

/**
 * Effective cast cost per unlocked ability, with upgrade-tier price changes
 * (`cost` overrides and `costMultiplier` discounts) applied — so the HUD's
 * price tags always match what the server will actually charge. Exported for
 * tests; production callers go through `broadcastGameState`.
 */
export function abilityCosts(p: PlayerState): Record<string, number> {
  const costs: Record<string, number> = {};
  for (const [id, unlocked] of Object.entries(p.unlocked)) {
    if (!unlocked) continue;
    const def = ALL_ABILITIES[id];
    if (!def) continue;
    costs[id] = resolveAbility(def, p.upgrades[id] ?? 0).cost ?? 0;
  }
  return costs;
}

export function broadcastGameState(io: Server, match: Match): void {
  const state = match.gameState;
  if (!state) return;

  io.to(match.roomCode).emit("state:sync", {
    tick: state.tick,
    serverTime: Date.now(),
    players: state.getPlayers().map((p) => ({
      ...p,
      economy: { ...p.economy, nextCitizenCost: citizenCost(p) },
      castle: {
        ...p.castle,
        nextRepairCost: repairCost(p),
        nextShieldCost: shieldCost(p),
        // Ticks left on the buy-shield break cooldown (0 = ready to rebuy).
        shieldCooldownRemaining: Math.max(
          0,
          param("shield.breakCooldownTicks", SHIELD.BREAK_COOLDOWN_TICKS) -
            (state.tick - p.castle.shieldBrokenAtTick),
        ),
      },
      abilityCosts: abilityCosts(p),
    })),
    projectiles: [],
  });
}

/**
 * Announces the end of a match to everyone in the room: the winner's player id,
 * or null for a draw (no survivors). The client flips to the game-over screen.
 */
export function broadcastMatchEnded(io: Server, match: Match): void {
  io.to(match.roomCode).emit("match:ended", { winnerId: match.winnerId });
}

/**
 * Forwards a batch of authoritative gameplay events to everyone in the match's
 * room (Epic 9). These are the exact events the engine's EventBus emits — the
 * client's Pixi layer visualizes them and never derives gameplay from them.
 * Sent alongside `state:sync`; each event carries its own `tick` for timing.
 * No-op for an empty batch so idle ticks cost nothing.
 */
export function broadcastGameEvents(io: Server, match: Match, events: GameplayEvent[]): void {
  if (events.length === 0) return;
  io.to(match.roomCode).emit("evt:batch", { tick: match.gameState?.tick ?? 0, events });
}
