import { COMBAT } from "../data/balance.js";
import { param } from "./parameters.js";
import { computeStat } from "./modifiers.js";
import {
  elementalDamageMultiplier,
  damageMultiplier,
  shieldDamageMultiplier,
  critChanceModifier,
  critDamageMultiplier
} from "./passives.js";
import type { PlayerState } from "../match/playerState.js";

/**
 * Reusable damage engine (ticket #64). Computes the *incoming* damage of a hit —
 * its base amount plus a critical-strike roll — as a plain, deterministic
 * calculation any ability can share (ARCHITECTURE.md §7 step 5, "Apply damage").
 *
 * This is deliberately the stage **before** modifiers and mitigation: it does
 * not read attacker/defender buff–debuff `Modifier`s, resistances, shields, or
 * castle HP. Later pipeline stages take this result and apply those (shields
 * absorb before HP, per DATA_MODELS.md §9). Keeping the raw calculation isolated
 * makes it pure and trivially testable, and lets crit chance/multiplier be fed
 * in from wherever the caller computed them.
 *
 * Damage is a non-negative integer (DATA_MODELS.md §Units).
 */

export interface DamageInput {
  /** Base damage of the hit, before crit or any modifiers. */
  amount: number;
  /**
   * Probability (0–1) of a critical strike. Defaults to `COMBAT.BASE_CRIT_CHANCE`.
   * Clamped to [0, 1].
   */
  critChance?: number;
  /**
   * Damage multiplier applied on a crit. Defaults to `COMBAT.BASE_CRIT_MULTIPLIER`.
   * Values below 1 are treated as 1 (a crit never reduces damage).
   */
  critMultiplier?: number;
  /**
   * Forces the crit outcome, skipping the roll: `true` = always crit, `false` =
   * never crit. Omit to roll against `critChance`. Useful for abilities that
   * guarantee/forbid crits and for deterministic tests.
   */
  forceCrit?: boolean;
  /** Injectable RNG (returns 0–1) for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
}

export interface DamageResult {
  /** Incoming damage before defender modifiers and mitigation are applied. */
  amount: number;
  /** The base damage before the crit multiplier (integer, clamped ≥ 0). */
  baseAmount: number;
  /** Whether this hit critically struck. */
  crit: boolean;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Rounds a pipeline damage value to an integer, absorbing floating-point error
 * from the multiplier chain so intended half-values round up. Without this,
 * e.g. `650 * 1.15` evaluates to 747.4999999999999 and `Math.round` floors it to
 * 747 instead of the intended 748. The epsilon is relative so it stays safe for
 * large hits, and far too small to flip any genuine sub-half value.
 */
const roundDamage = (n: number): number =>
  Math.round(n + Math.max(1, Math.abs(n)) * 1e-9);

/**
 * Calculates the incoming damage for a single hit. Pure: given the same inputs
 * (and RNG) it always returns the same result, and it mutates nothing.
 */
export function computeIncomingDamage(input: DamageInput): DamageResult {
  const baseAmount = Math.max(0, roundDamage(input.amount));
  const critChance = clamp01(
    input.critChance ?? param("combat.baseCritChance", COMBAT.BASE_CRIT_CHANCE),
  );
  const critMultiplier = Math.max(
    1,
    input.critMultiplier ??
      param("combat.baseCritMultiplier", COMBAT.BASE_CRIT_MULTIPLIER),
  );
  const rng = input.rng ?? Math.random;

  const crit = input.forceCrit ?? rng() < critChance;
  const amount = crit ? roundDamage(baseAmount * critMultiplier) : baseAmount;

  return { amount, baseAmount, crit };
}

// ---------------------------------------------------------------------------
// Damage modifier pipeline (ticket #68)
// ---------------------------------------------------------------------------

export interface ResolveDamageOptions {
  /**
   * The attack's element (e.g. "fire", "water"), from ability data. Consumed
   * by defender kingdom passives (elemental resistance, ticket #81) and, when
   * the matchup table lands, elemental interactions.
   */
  element?: string;
  /**
   * Elemental interaction multiplier (attacker's element vs defender's).
   * Supplied by ability data / the elemental matchup table when that data
   * lands; defaults to neutral (1). Values below 0 are treated as 0.
   */
  elementMultiplier?: number;
  /** Forces the crit outcome (see DamageInput.forceCrit). */
  forceCrit?: boolean;
  /** Injectable RNG for deterministic tests. */
  rng?: () => number;
  /** If set, the hit bypasses shields. */
  ignoreShields?: boolean;
  /**
   * Ability-level bonus multiplier against shielded targets (Earth's Meteor
   * Shower, Epic 9). Composes with the attacker's shieldDamageMultiplier
   * kingdom passive (e.g. Fire's Roast!).
   */
  shieldDamageMultiplier?: number;
  /**
   * With a shield multiplier, excess bonus damage normally caps at the shield
   * (the remainder carries at ×1). Set to let the full multiplied damage carry
   * into castle HP instead (Meteor Shower Lv 5).
   */
  shieldDamageOverflow?: boolean;
}

export interface ResolvedDamage extends DamageResult {
  /** Damage after the attacker's "damage" modifiers, before element/crit. */
  afterAttackerModifiers: number;
  /** Damage after the elemental multiplier, before the crit roll. */
  afterElement: number;
}

/**
 * The full pre-mitigation damage pipeline (ticket #68). Applies, in order:
 *
 *   1. attacker "damage" modifiers — passives, buffs, debuffs, and temporary
 *      ability effects all live in the shared Modifier system, so one
 *      `computeStat` pass composes them without conflicts ((base + Σadd) × Πmult);
 *   2. the elemental interaction multiplier;
 *   3. the crit roll — crit chance/multiplier are themselves modifiable stats
 *      ("critChance", "critMultiplier"), based on the shared COMBAT constants;
 *   4. defender "damageTaken" modifiers — vulnerabilities and resistances.
 *
 * The result is the final incoming damage, ready for shield/HP application
 * (`applyDamage` in combat.ts). Pure aside from the RNG.
 */
export function resolveDamage(
  attacker: PlayerState,
  defender: PlayerState,
  baseAmount: number,
  options: ResolveDamageOptions = {},
): ResolvedDamage {
  const base = Math.max(0, baseAmount);

  // 1. Attacker-side modifiers (buffs/debuffs/passives/temp effects).
  const afterAttackerModifiers = Math.max(
    0,
    computeStat(attacker, "damage", base, defender, "caster", options.element) * damageMultiplier(attacker, defender, options.element),
  );

  // 2. Elemental interaction.
  const element = Math.max(0, options.elementMultiplier ?? 1);
  let afterElement = afterAttackerModifiers * element;

  // Shield damage multiplier (passives, ticket #105; ability-level, Epic 9)
  if (!options.ignoreShields && defender.castle.shield > 0) {
    const shieldMult =
      shieldDamageMultiplier(attacker, defender, options.element) *
      (options.shieldDamageMultiplier ?? 1);
    if (shieldMult !== 1) {
      const maxShieldDamage = defender.castle.shield;
      const potentialShieldDamage = afterElement * shieldMult;
      if (options.shieldDamageOverflow || potentialShieldDamage <= maxShieldDamage) {
        // Overflow (Meteor Shower Lv 5): the full multiplied damage applies —
        // whatever the shield doesn't absorb carries into castle HP.
        afterElement = potentialShieldDamage;
      } else {
        const overflow = afterElement - maxShieldDamage / shieldMult;
        afterElement = maxShieldDamage + overflow;
      }
    }
  }

  // 3. Crit roll, with modifier-aware chance and multiplier (#67).
  const rolled = computeIncomingDamage({
    amount: afterElement,
    critChance: computeStat(attacker, "critChance", param("combat.baseCritChance", COMBAT.BASE_CRIT_CHANCE), defender, "caster") + critChanceModifier(attacker),
    critMultiplier: computeStat(
      attacker,
      "critMultiplier",
      param("combat.baseCritMultiplier", COMBAT.BASE_CRIT_MULTIPLIER),
      defender,
      "caster",
    ) + (critDamageMultiplier(attacker) - 1),
    forceCrit: options.forceCrit,
    rng: options.rng,
  });

  // 4. Defender-side modifiers (vulnerability adds/mults, resistances < 1)
  // and kingdom elemental resistance passives (ticket #81).
  const amount = Math.max(
    0,
    roundDamage(
      // The element is passed so defender-side modifiers can gate on it
      // (e.g. Burn amplifying incoming Fire damage from its applier).
      computeStat(defender, "damageTaken", rolled.amount, attacker, "target", options.element) *
        elementalDamageMultiplier(defender, options.element),
    ),
  );

  return {
    amount,
    baseAmount: rolled.baseAmount,
    crit: rolled.crit,
    afterAttackerModifiers,
    afterElement,
  };
}
