import type { Match } from "../match/Match.js";
import { applyPassiveIncome } from "./economy.js";
import { processStatusTicks, tickStatuses } from "./status.js";
import { tickModifiers } from "./modifiers.js";
import { tickCooldowns, tickRecharges } from "./cooldowns.js";
import { collapseBlackHoles, resolvePendingStrikes } from "./abilities.js";
import { processDeaths } from "./elimination.js";
import { resolveWinner } from "./winConditions.js";

/**
 * Runs a single authoritative game tick for a match. Phases run in the order
 * defined by GAME_TICK.md (economy → status → cooldowns → win check). Systems
 * are added here as their tickets land. Returns true if this tick ended the
 * match.
 */
export function tickMatch(match: Match, tick: number): boolean {
  match.tick = tick;
  const state = match.gameState;
  if (!state) return false;
  state.tick = tick;

  // Economy phase: passive income.
  applyPassiveIncome(state);

  // Status phase: run recurring per-tick effects (burn, regen, … — #78), then
  // advance durations and expire finished statuses.
  processStatusTicks(state, match.rng); // #203: seeded status procs
  tickStatuses(state);

  // Modifier phase: advance buff/debuff durations, expire finished ones.
  tickModifiers(state);

  // Cooldown phase: advance every ability's cooldown and charge regeneration.
  tickCooldowns(state);
  tickRecharges(state);

  // Space's Black Hole: if one is open and its time is up, collapse it and dump
  // the pooled damage on the last kingdom that fed it (before death detection so
  // a fatal dump is resolved this tick).
  collapseBlackHoles(match);

  // Light's "Light Show": land any telegraphed field-wide strike whose warning
  // window has run out (also before death detection).
  resolvePendingStrikes(match);

  // Death phase: detect castles at 0 HP and run the elimination process
  // (tickets #69–#70) before checking whether the match is over.
  processDeaths(match);

  // Win-condition phase: end the match when one kingdom remains.
  const outcome = resolveWinner(state);
  if (outcome.ended) {
    match.end(outcome.winnerId);
    // Gameplay event (#204): the match is over.
    if (state.events.enabled) {
      state.events.emit({
        type: "matchEnded",
        tick,
        winnerId: outcome.winnerId,
      });
    }
    return true;
  }
  return false;
}
