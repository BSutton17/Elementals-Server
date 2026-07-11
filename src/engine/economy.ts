import { ECONOMY } from "../data/balance.js";
import type { GameState } from "../match/GameState.js";
import type { PlayerState } from "../match/playerState.js";
import { computeStat } from "./modifiers.js";
import { param } from "./parameters.js";
import { incomeRatePerCitizen, productionMultiplier } from "./passives.js";
import { earn, roundMoney } from "./money.js";

/**
 * A player's effective per-tick income: citizens × rate, adjusted by any active
 * "income" modifiers (ticket #48) and kingdom production passives (ticket #81),
 * both applied automatically by the engine. A kingdom passive may override the
 * per-citizen rate itself (Water's "We're In This Together").
 */
export function computeIncome(player: PlayerState): number {
  const rate =
    incomeRatePerCitizen(player) ??
    param("economy.incomePerCitizen", ECONOMY.INCOME_PER_CITIZEN);
  const base = player.economy.citizens * rate;
  return roundMoney(computeStat(player, "income", base) * productionMultiplier(player));
}

/**
 * Recalculates and stores a player's `incomePerTick` (ticket #55). Call whenever
 * their citizen count (or an income modifier) changes so the value is always
 * current, not stale until the next tick.
 */
export function recalcIncome(player: PlayerState): void {
  player.economy.incomePerTick = computeIncome(player);
}

/**
 * Passive income (ticket #45): each tick, every living player earns money based
 * on their citizen count. Eliminated players earn nothing. Money is credited
 * through the money system (ticket #51).
 */
export function applyPassiveIncome(state: GameState): void {
  for (const player of state.getPlayers()) {
    if (player.eliminated) continue;
    recalcIncome(player);
    earn(player, player.economy.incomePerTick);
  }
}
