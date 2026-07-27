import { ECONOMY } from "../data/balance.js";
import type { GameState } from "../match/GameState.js";
import type { PlayerState } from "../match/playerState.js";
import { computeStat } from "./modifiers.js";
import { param } from "./parameters.js";
import {
  besiegedIncomePerTick,
  besiegerIncomeMultiplier,
  incomeRatePerCitizen,
  productionMultiplier,
} from "./passives.js";
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
  const players = state.getPlayers();
  for (const player of players) {
    if (player.eliminated) continue;
    recalcIncome(player);
    // Time's "Back to the Future": time runs backward on this treasury — the
    // castle LOSES its gold/sec instead of earning, floored at 0, for the
    // ultimate's duration. Suppresses income entirely (no besieged bonus).
    if (player.statuses.some((s) => s.drainsIncome)) {
      player.economy.currency = Math.max(
        0,
        roundMoney(player.economy.currency - player.economy.incomePerTick),
      );
      continue;
    }
    // Pressure-driven income: Space's "Vast Universe" multiplies income by the
    // number of kingdoms targeting it; the universal "Besieged" bonus adds a
    // flat defensive top-up. Both fold into incomePerTick so the HUD reflects it.
    player.economy.incomePerTick = roundMoney(
      player.economy.incomePerTick * besiegerIncomeMultiplier(player, players) +
        besiegedIncomePerTick(player, players),
    );
    earn(player, player.economy.incomePerTick);
  }
}
