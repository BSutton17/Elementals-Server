import { TICK } from "./balance.js";
import { FROZEN_STATUS, FROZEN_DURATION, FROSTBITE_STATUS } from "./iceAbilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * The seven elemental kingdoms. This is the canonical id list; full kingdom
 * definitions (abilities, theme, …) are data added under this folder as those
 * systems are implemented (see ARCHITECTURE.md).
 *
 * Kingdoms are NOT exclusive within a match: a match allows up to 8 players but
 * there are only 7 kingdoms, so multiple players may share one.
 */
export const KINGDOM_IDS = [
  "water",
  "fire",
  "air",
  "earth",
  "electricity",
  "ice",
  "nature",
] as const;

export type KingdomId = (typeof KINGDOM_IDS)[number];

export function isKingdomId(value: unknown): value is KingdomId {
  return (
    typeof value === "string" &&
    (KINGDOM_IDS as readonly string[]).includes(value)
  );
}

/**
 * Generic, engine-applied kingdom passive primitives (ticket #81+). A kingdom's
 * always-on passives are pure data composed from these; the engine applies them
 * automatically with no kingdom-specific branches:
 *  - `productionPerCitizen`: income multiplied by (1 + pct × citizens).
 *  - `statusDurationReduction`: named statuses applied to this kingdom last
 *    (1 − pct) of their normal duration.
 *  - `elementalResistance`: damage of the named element takes (1 − pct).
 */
export type KingdomPassive = (
  | { type: "productionPerCitizen"; pct: number }
  /** Overrides the per-citizen income rate outright (per tick). Water: every
   *  citizen produces $1.35/s (0.0675/tick) vs the base $1.20/s. */
  | { type: "incomePerCitizen"; amount: number }
  | { type: "statusDurationReduction"; statusId: string; pct: number }
  | { type: "elementalResistance"; element: string; pct: number }
  | { type: "startingCastleHpMultiplier"; pct: number }
  | { type: "damageMultiplier"; pct: number }
  | { type: "shieldDamageMultiplier"; pct: number }
  | { type: "critChanceModifier"; pct: number }
  | { type: "critDamageMultiplier"; pct: number }
  /** Attacks may be cast with multiple explicit targets (Air, Epic 8). */
  | { type: "multiTargetAttacks"; maxTargets: number }
  /** Incoming attacks have this chance to be redirected to another kingdom,
   *  the attacker included (Air, Epic 8). */
  | { type: "attackRedirectChance"; pct: number }
  /** Begin the game with this much shield (Earth, Epic 9). */
  | { type: "startingShield"; amount: number }
  /** Dealing ability damage regenerates the caster's shield by this fraction
   *  of the damage dealt (Earth's "Distraught", Epic 9). */
  | { type: "shieldOnDamageDealt"; pct: number }
  /** Attack cooldowns are reduced by this fraction (Electricity, Epic 10). */
  | { type: "attackCooldownReduction"; pct: number }
  /** Attacks have `chance` to deal `pct` of the hit as bonus damage after
   *  hitting (Electricity's "AfterShock", Epic 10). */
  | { type: "attackAftershock"; chance: number; pct: number }
  /** Attacks have `chance` to inflict `status` on the victim (Ice's
   *  "Cold Embrace", Epic 11). Honors Frozen Focus guarantees. */
  | { type: "onHitStatus"; chance: number; durationTicks: number; status: StatusEffectDefinition }
  /** Being attacked has `chance` to inflict `status` on the attacker (Ice's
   *  "Frostbite", Epic 11). */
  | { type: "retaliation"; chance: number; durationTicks: number; status: StatusEffectDefinition }
  /** Attackers have `chance` to receive `pct` of their damage reflected
   *  (Nature's "No Rose Without Thorns", Epic 12). */
  | { type: "thorns"; chance: number; pct: number }
  /** Begin the game with this many additional citizens (Nature's
   *  "Gardener's Gift", Epic 12). */
  | { type: "startingCitizensBonus"; amount: number }
) & { conditions?: any[] };

/**
 * Always-on passives per kingdom. Kingdoms are filled in as their epics land;
 * an empty list means "no engine-applied passives yet".
 *
 * Water (Epic 6, ticket #81):
 *  - "We're In This Together" — every citizen produces $1.35/s vs base $1.20/s.
 *  - "Fountain of Youth" — 40% reduced Burn duration; 15% less Fire damage.
 *
 * Air (Epic 8):
 *  - "Embrace of Winds" — attacks may target multiple kingdoms simultaneously.
 *  - "A Gust of Envy" — incoming attacks have a 5% chance to be redirected to
 *    another kingdom, including the attacker.
 *
 * Earth (Epic 9):
 *  - "Rock Hard Determination" — begin the game with a fully intact shield
 *    (Brick Wall-sized, 2500).
 *  - "Distraught" — whenever Earth damages an opponent, its shield slowly
 *    regenerates (10% of damage dealt returns as shield).
 *
 * Electricity (Epic 10):
 *  - "Don't Blink" — all attack cooldowns reduced by 30%.
 *  - "AfterShock" — attacks have a 25% chance to deal 50% of the hit as bonus
 *    damage after hitting.
 *
 * Ice (Epic 11):
 *  - "Cold Embrace" — Ice attacks have a 10% chance to Freeze opponents.
 *  - "Frostbite" — attackers have a 15% chance to have their production
 *    slowed by 50% for a short duration.
 *  - (weakness) Burn lasts 1.5× longer on Ice.
 *
 * Nature (Epic 12):
 *  - "No Rose Without Thorns" — attackers have a 20% chance to receive 25%
 *    of their damage reflected.
 *  - "Gardener's Gift" — begin the game with 15 citizens instead of 10.
 */
export const KINGDOM_PASSIVES: Record<KingdomId, KingdomPassive[]> = {
  water: [
    // "We're In This Together": every Water citizen produces $1.35/s
    // (0.0675/tick) — a flat per-citizen rate above the base $1.20/s.
    { type: "incomePerCitizen", amount: 0.0675 },
    { type: "statusDurationReduction", statusId: "burn", pct: 0.4 },
    { type: "elementalResistance", element: "fire", pct: 0.15 },
  ],
  fire: [
    { type: "startingCastleHpMultiplier", pct: 0.85 },
    { type: "damageMultiplier", pct: 0.25 },
    { type: "shieldDamageMultiplier", pct: 0.35 },
  ],
  air: [
    // "Embrace of Winds": attacks may strike up to maxTargets kingdoms at once
    // (damage split evenly). Tunable via passive.air.0.maxTargets; design intent
    // is 3 base, 5 when upgraded (raise this value for the upgraded tier).
    { type: "multiTargetAttacks", maxTargets: 3 },
    { type: "attackRedirectChance", pct: 0.05 },
  ],
  earth: [
    { type: "startingShield", amount: 2500 },
    { type: "shieldOnDamageDealt", pct: 0.1 },
  ],
  electricity: [
    { type: "attackCooldownReduction", pct: 0.3 },
    { type: "attackAftershock", chance: 0.25, pct: 0.5 },
  ],
  ice: [
    { type: "statusDurationReduction", statusId: "burn", pct: -0.50 },
    { type: "onHitStatus", chance: 0.10, durationTicks: FROZEN_DURATION, status: FROZEN_STATUS },
    { type: "retaliation", chance: 0.15, durationTicks: 5 * TICK.RATE, status: FROSTBITE_STATUS },
  ],
  nature: [
    { type: "thorns", chance: 0.2, pct: 0.25 },
    { type: "startingCitizensBonus", amount: 5 },
  ],
};
