import { PERKS } from "../data/balance.js";
import type { PerkId } from "../data/perks.js";
import { param } from "./parameters.js";
import type { PlayerState } from "../match/playerState.js";

/**
 * Perk application (mirrors `passives.ts` for kingdom passives). Reads a
 * player's two selected perks and exposes the single multiplier/bonus each
 * engine system consumes, so no system needs a perk-specific branch — it just
 * multiplies one more factor into a chain it already computes.
 *
 * Every magnitude reads through the balance-parameter system (ticket #202) so
 * perks are tunable like everything else; the live game takes the fast path.
 */

export function hasPerk(player: PlayerState, perk: PerkId): boolean {
  return player.perks.includes(perk);
}

/** "Sharper Swords" — outgoing ability damage multiplier (1 = no perk). */
export function perkDamageMultiplier(player: PlayerState): number {
  return hasPerk(player, "sharperSwords")
    ? 1 + param("perk.attackPct", PERKS.ATTACK_PCT)
    : 1;
}

/** "Sharper Axes" — extra outgoing damage against a shielded castle. Composes
 *  with Fire's "Roast!" and ability-level shield multipliers. */
export function perkShieldDamageMultiplier(player: PlayerState): number {
  return hasPerk(player, "sharperAxes")
    ? 1 + param("perk.shieldAttackPct", PERKS.SHIELD_ATTACK_PCT)
    : 1;
}

/** "Extra Guards" — multiplier on ALL damage this player takes (1 = no perk). */
export function perkDamageTakenMultiplier(player: PlayerState): number {
  return hasPerk(player, "extraGuards")
    ? Math.max(0, 1 - param("perk.damageReductionPct", PERKS.DAMAGE_REDUCTION_PCT))
    : 1;
}

/**
 * "Extra Medics" — multiplier on damage-over-time (per-tick status) damage this
 * player takes. Applied ON TOP of "Extra Guards" when both are picked: perks
 * stack, so a DoT tick against a player holding both takes 0.9 × 0.85.
 */
export function perkDotDamageTakenMultiplier(player: PlayerState): number {
  return hasPerk(player, "extraMedics")
    ? Math.max(0, 1 - param("perk.dotReductionPct", PERKS.DOT_REDUCTION_PCT))
    : 1;
}

/** "Extra Repairs" — multiplier on every ability cooldown (1 = no perk). */
export function perkCooldownMultiplier(player: PlayerState): number {
  return hasPerk(player, "extraRepairs")
    ? Math.max(0, 1 - param("perk.cooldownReductionPct", PERKS.COOLDOWN_REDUCTION_PCT))
    : 1;
}

/** "Great Merchants" — multiplier on ability unlock prices (1 = no perk). */
export function perkUnlockCostMultiplier(player: PlayerState): number {
  return hasPerk(player, "greatMerchants")
    ? Math.max(0, 1 - param("perk.unlockDiscountPct", PERKS.UNLOCK_DISCOUNT_PCT))
    : 1;
}

/** "Better Construction" — extra health on every shield this player gains. */
export function perkShieldBonusHp(player: PlayerState): number {
  return hasPerk(player, "betterConstruction")
    ? param("perk.shieldBonusHp", PERKS.SHIELD_BONUS_HP)
    : 0;
}

/**
 * "Deep Pockets" — gold in the bank at match start. Takes the raw perk list
 * rather than a PlayerState: it is read while that state is being built.
 */
export function perkStartingGold(perks: readonly PerkId[]): number {
  return perks.includes("deepPockets")
    ? param("perk.startingGold", PERKS.STARTING_GOLD)
    : 0;
}

/**
 * "Better Construction" against a raw perk list, for the same reason as
 * `perkStartingGold` — the starting shield is granted during state creation.
 */
export function perkShieldBonusHpFor(perks: readonly PerkId[]): number {
  return perks.includes("betterConstruction")
    ? param("perk.shieldBonusHp", PERKS.SHIELD_BONUS_HP)
    : 0;
}
