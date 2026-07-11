import type { PlayerState } from "../match/playerState.js";

/**
 * Damage application pipeline (tickets #65–#66). Takes an already-computed
 * incoming damage amount (see the damage engine, `computeIncomingDamage`) and
 * applies it to a target castle in the authoritative order:
 *
 *   1. Shields absorb first (#65) — the castle's shield pool soaks damage before
 *      any reaches HP, unless the hit explicitly `ignoreShields`.
 *   2. Overflow hits castle HP (#66) — whatever the shields did not absorb
 *      reduces `castle.hp`, clamped at 0. Reaching 0 eliminates the castle
 *      (DATA_MODELS.md §9: hp is clamped to [0, maxHp]; 0 ⇒ eliminated).
 *
 * Pure aside from mutating the target's castle/elimination state; returns a
 * breakdown so callers can drive sync/events. Already-eliminated castles and
 * non-positive damage are safe no-ops.
 */

export interface DamageOptions {
  /** If set, the hit bypasses shields and applies directly to castle HP. */
  ignoreShields?: boolean;
}

export interface DamageApplication {
  /** Incoming damage after clamping to a non-negative integer. */
  incoming: number;
  /** How much the shield pool absorbed. */
  absorbedByShield: number;
  /** How much castle HP was actually lost. */
  dealtToHp: number;
  /** Shield pool remaining after absorption. */
  shieldRemaining: number;
  /** Castle HP remaining after the hit. */
  hpRemaining: number;
  /** True only if this hit reduced the castle from alive to 0 HP. */
  eliminated: boolean;
}

export function applyDamage(
  target: PlayerState,
  incoming: number,
  options: DamageOptions = {},
): DamageApplication {
  const amount = Math.max(0, Math.round(incoming));

  const noop = (): DamageApplication => ({
    incoming: amount,
    absorbedByShield: 0,
    dealtToHp: 0,
    shieldRemaining: target.castle.shield,
    hpRemaining: target.castle.hp,
    eliminated: false,
  });

  // Nothing to do for a dead castle or a harmless hit.
  if (target.eliminated || amount === 0) return noop();

  let remaining = amount;

  // 1. Shields absorb first (#65), unless the attack ignores them.
  let absorbedByShield = 0;
  if (!options.ignoreShields && target.castle.shield > 0) {
    absorbedByShield = Math.min(target.castle.shield, remaining);
    target.castle.shield -= absorbedByShield;
    remaining -= absorbedByShield;
  }

  // 2. Remaining damage hits castle HP (#66), clamped at 0.
  const dealtToHp = Math.min(target.castle.hp, remaining);
  target.castle.hp -= dealtToHp;

  const eliminated = target.castle.hp <= 0;
  if (eliminated) {
    target.castle.hp = 0;
    target.eliminated = true;
  }

  return {
    incoming: amount,
    absorbedByShield,
    dealtToHp,
    shieldRemaining: target.castle.shield,
    hpRemaining: target.castle.hp,
    eliminated,
  };
}
