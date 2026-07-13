import { CASTLE, ECONOMY, SHIELD } from "../data/balance.js";
import { ALL_ABILITIES } from "../data/abilitiesRegistry.js";
import type { Match } from "../match/Match.js";
import type { PlayerState } from "../match/playerState.js";
import { spend } from "./money.js";
import { recalcIncome } from "./economy.js";
import { purchaseUpgrade } from "./abilities.js";
import { validateTransaction, type TransactionResult } from "./transactions.js";
import { param } from "./parameters.js";

/**
 * Gameplay purchases (ticket #53+). Each purchase validates through the
 * transaction system (funds + legality) before spending and applying its
 * effect, so nothing is granted unless it was paid for.
 */

/**
 * Cost of the player's next citizen. Scales with how many they've already
 * purchased (ticket #54): CITIZEN_COST × GROWTH^purchased, rounded to dollars.
 */
export function citizenCost(player: PlayerState): number {
  const purchased = player.economy.citizensPurchased;
  return Math.round(
    param("economy.citizenCost", ECONOMY.CITIZEN_COST) *
      param("economy.citizenCostGrowth", ECONOMY.CITIZEN_COST_GROWTH) ** purchased,
  );
}

/** Whether a status bars the player from citizen/repair purchases (Epic 12,
 *  Nature's Toxic Gas). Shields stay purchasable. */
function purchasesBlocked(player: PlayerState): boolean {
  return player.statuses.some((s) => s.blocksPurchases);
}

/** Purchases one additional citizen for the player at its current scaled cost. */
export function buyCitizen(match: Match, player: PlayerState): TransactionResult {
  if (purchasesBlocked(player)) {
    return { ok: false, error: "PURCHASES_BLOCKED" };
  }
  const cost = citizenCost(player);
  const validation = validateTransaction(match, player, cost);
  if (!validation.ok) return validation;

  spend(player, cost);
  player.economy.citizens += 1;
  player.economy.citizensPurchased += 1;
  // Citizen count changed — refresh income immediately (ticket #55).
  recalcIncome(player);

  // Gameplay events (#204).
  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({ type: "purchase", tick: match.tick, playerId: player.id, kind: "citizen", cost });
    bus.emit({
      type: "citizensChanged",
      tick: match.tick,
      playerId: player.id,
      delta: 1,
      total: player.economy.citizens,
      cause: "purchase",
    });
  }
  return { ok: true };
}

/**
 * Cost of the player's next repair (ticket #57): a flat `REPAIR_COST` scaled
 * by `REPAIR_COST_GROWTH^repairs` so each repair costs more than the last
 * (1000 → 1250 → 1563). Returns 0 once the `MAX_REPAIRS` cap is spent.
 */
export function repairCost(player: PlayerState): number {
  if (player.castle.repairs >= param("castle.maxRepairs", CASTLE.MAX_REPAIRS)) return 0;
  return Math.round(
    param("castle.repairCost", CASTLE.REPAIR_COST) *
      param("castle.repairCostGrowth", CASTLE.REPAIR_COST_GROWTH) **
        player.castle.repairs,
  );
}

/**
 * Repairs the player's castle (ticket #56): restores up to `REPAIR_AMOUNT` HP
 * (never above max) at the current, progressively-scaling cost (ticket #57).
 * Capped at `MAX_REPAIRS` purchases per match — ability-based healing is
 * unaffected by the cap.
 */
export function repairCastle(match: Match, player: PlayerState): TransactionResult {
  if (purchasesBlocked(player)) {
    return { ok: false, error: "PURCHASES_BLOCKED" };
  }
  if (player.castle.repairs >= param("castle.maxRepairs", CASTLE.MAX_REPAIRS)) {
    return { ok: false, error: "REPAIR_LIMIT" };
  }
  const missing = player.castle.maxHp - player.castle.hp;
  if (missing <= 0) {
    return { ok: false, error: "INVALID_TRANSACTION" }; // already full
  }

  const repaired = Math.min(param("castle.repairAmount", CASTLE.REPAIR_AMOUNT), missing);
  const cost = repairCost(player);

  const validation = validateTransaction(match, player, cost);
  if (!validation.ok) return validation;

  spend(player, cost);
  player.castle.hp += repaired;
  player.castle.repairs += 1;

  // Gameplay events (#204).
  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({ type: "purchase", tick: match.tick, playerId: player.id, kind: "repair", cost });
    bus.emit({ type: "heal", tick: match.tick, targetId: player.id, amount: repaired, overheal: param("castle.repairAmount", CASTLE.REPAIR_AMOUNT) - repaired, cause: "repair" });
  }
  return { ok: true };
}

/**
 * Purchases the standard shield (ticket #58): grants `SHIELD.STANDARD_HP` of
 * shield health for `SHIELD.COST`.
 *
 * Cannot buy another standard shield while one is already active (ticket #59).
 * Kingdom abilities that grant shields apply them directly (via the effect
 * engine), bypassing this purchase guard.
 */
export function buyShield(match: Match, player: PlayerState): TransactionResult {
  if (player.castle.shield > 0) {
    return { ok: false, error: "SHIELD_ACTIVE" };
  }

  const shieldCost = param("shield.cost", SHIELD.COST);
  const validation = validateTransaction(match, player, shieldCost);
  if (!validation.ok) return validation;

  spend(player, shieldCost);
  const granted = param("shield.standardHp", SHIELD.STANDARD_HP);
  player.castle.shield += granted;

  // Gameplay events (#204).
  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({ type: "purchase", tick: match.tick, playerId: player.id, kind: "shield", cost: shieldCost });
    bus.emit({
      type: "shieldGained",
      tick: match.tick,
      playerId: player.id,
      amount: granted,
      total: player.castle.shield,
      cause: "purchase",
    });
  }
  return { ok: true };
}

/**
 * Buys a locked ability, or upgrades an already-bought one.
 *
 * Every ability starts locked. Buying it costs 50% of its cast cost and makes
 * it usable at its base strength ("level 1" in UI terms — `unlocked` is set,
 * `upgrades` stays at tier 0). Once bought, further purchases go through the
 * standard tier upgrade system (`purchaseUpgrade`, ticket #75).
 */
export function unlockOrUpgradeAbility(
  match: Match,
  player: PlayerState,
  abilityId: string,
): TransactionResult & { level?: number } {
  const ability = ALL_ABILITIES[abilityId as keyof typeof ALL_ABILITIES];
  if (!ability) {
    return { ok: false, error: "INVALID_TRANSACTION" };
  }

  if (!player.unlocked[abilityId]) {
    // Buying the ability: its explicit unlock price when set (e.g. Lightning
    // Barrage at 125g), otherwise 50% of its cast cost. No free upgrade tiers.
    const unlockCost = param(
      `ability.${abilityId}.unlockCost`,
      ability.unlockCost ?? Math.ceil((ability.cost ?? 0) * 0.5),
    );
    const validation = validateTransaction(match, player, unlockCost);
    if (!validation.ok) return validation;

    spend(player, unlockCost);
    player.unlocked[abilityId] = true;

    // Gameplay event (#204).
    const bus = match.gameState!.events;
    if (bus.enabled) {
      bus.emit({
        type: "purchase",
        tick: match.tick,
        playerId: player.id,
        kind: "unlock",
        itemId: abilityId,
        cost: unlockCost,
      });
    }
    return { ok: true, level: 1 };
  }

  // Already bought — purchase the next upgrade tier.
  const result = purchaseUpgrade(match, player, ability);
  if (!result.ok) return result;
  return { ok: true, level: (result.level ?? 0) + 1 };
}
