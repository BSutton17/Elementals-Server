import { KINGDOM_PASSIVES, type KingdomPassive } from "../data/kingdoms.js";
import { COMBAT, TICK } from "../data/balance.js";
import type { PlayerState } from "../match/playerState.js";
import type { StatusEffectDefinition } from "./status.js";
import { evaluateCondition } from "./conditions.js";
import { getActiveParameterSet, param } from "./parameters.js";

/**
 * Kingdom passive application (ticket #81). Reads the generic passive
 * primitives declared in kingdom data and exposes the multipliers the engine
 * systems consume — economy (production), statuses (duration), and the damage
 * pipeline (elemental resistance). Contains no kingdom-specific logic: any
 * kingdom gains any of these behaviors by declaring the data.
 */

export function kingdomPassives(player: PlayerState): KingdomPassive[] {
  const passives = KINGDOM_PASSIVES[player.kingdomId] ?? [];
  // Balance-parameter overrides (ticket #202): with an active candidate set,
  // every numeric field of every passive is tunable via
  // `passive.<kingdom>.<index>.<field>`. Production takes the fast path.
  if (getActiveParameterSet() === null) return passives;
  return passives.map((p, i) => {
    const tuned: Record<string, unknown> = { ...p };
    for (const key of Object.keys(tuned)) {
      const value = tuned[key];
      if (typeof value === "number") {
        tuned[key] = param(
          `passive.${player.kingdomId}.${i}.${key}`,
          value,
        );
      }
    }
    return tuned as KingdomPassive;
  });
}

/** Income multiplier from production passives, e.g. 1 + 0.10 × citizens. */
export function productionMultiplier(player: PlayerState): number {
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "productionPerCitizen") {
      mult *= 1 + p.pct * player.economy.citizens;
    }
  }
  return mult;
}

/** Per-citizen income rate override (per tick), or null to use the base rate
 *  (Water's "We're In This Together": $0.90/s per citizen vs base $0.80/s). */
export function incomeRatePerCitizen(player: PlayerState): number | null {
  for (const p of kingdomPassives(player)) {
    if (p.type === "incomePerCitizen") return p.amount;
  }
  return null;
}

/** Duration multiplier for a status applied *to* this player (1 = normal). */
export function statusDurationMultiplier(
  player: PlayerState,
  statusId: string,
): number {
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "statusDurationReduction" && p.statusId === statusId) {
      mult *= Math.max(0, 1 - p.pct);
    }
  }
  return mult;
}

/**
 * Damage-taken multiplier from DoT-resistance passives (Water's "Fountain of
 * Youth"), for a given source id — a status id (a DoT tick like "burn"/"poison"/
 * "fatherTimeMark") or an ability id (direct damage like "meteorShower"). 1 when
 * the player has no matching resistance; multiple matches stack multiplicatively.
 */
export function dotResistanceMultiplier(
  player: PlayerState,
  sourceId: string | undefined,
): number {
  if (!sourceId) return 1;
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "dotResistance" && p.sources.includes(sourceId)) {
      mult *= Math.max(0, 1 - p.pct);
    }
  }
  return mult;
}

/** Damage multiplier for elemental damage taken by this player (1 = neutral). */
export function elementalDamageMultiplier(
  player: PlayerState,
  element: string | undefined,
): number {
  if (!element) return 1;
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "elementalResistance" && p.element === element) {
      mult *= Math.max(0, 1 - p.pct);
    }
  }
  return mult;
}

/** Living enemies currently targeting `player`. */
export function besiegerCount(
  player: PlayerState,
  allPlayers: readonly PlayerState[],
): number {
  let n = 0;
  for (const p of allPlayers) {
    if (!p.eliminated && p.id !== player.id && p.target === player.id) n++;
  }
  return n;
}

/**
 * "Besieged" stack count for `player`: living enemies currently targeting it
 * *beyond the first*, capped at `BESIEGED_MAX_STACKS`. 0 in a fair 1v1. Shared
 * by both besieged bonuses (outgoing damage and defensive income).
 */
export function besiegedStacks(
  player: PlayerState,
  allPlayers: readonly PlayerState[],
): number {
  return Math.min(
    param("combat.besiegedMaxStacks", COMBAT.BESIEGED_MAX_STACKS),
    Math.max(0, besiegerCount(player, allPlayers) - 1),
  );
}

/**
 * Income multiplier from the "income per besieger" passive (Space's "Vast
 * Universe"): ×(1 + pct × kingdoms currently targeting you). 1 without it.
 */
export function besiegerIncomeMultiplier(
  player: PlayerState,
  allPlayers: readonly PlayerState[],
): number {
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "incomeMultiplierPerBesieger") {
      mult *= 1 + p.pct * besiegerCount(player, allPlayers);
    }
  }
  return mult;
}

/**
 * "Besieged" outgoing-damage multiplier (universal, not a kingdom passive):
 * the more enemies are locked onto `attacker` right now, the harder its own
 * attacks land. Each stack adds `BESIEGED_DAMAGE_PER_ATTACKER` — so a 1v1 is
 * neutral (×1) and being ganged up on scales the comeback. Computed live from
 * targeting state, fed into the damage pipeline as an option.
 */
export function besiegedDamageMultiplier(
  attacker: PlayerState,
  allPlayers: readonly PlayerState[],
): number {
  const stacks = besiegedStacks(attacker, allPlayers);
  return 1 + param("combat.besiegedDamagePerAttacker", COMBAT.BESIEGED_DAMAGE_PER_ATTACKER) * stacks;
}

/**
 * "Besieged" defensive income bonus (universal): while ganged up on, your
 * citizens work harder — each besieging attacker beyond the first grants
 * `BESIEGED_INCOME_PER_ATTACKER` extra gold PER SECOND. Returned as a PER-TICK
 * amount so the passive-income phase can add it straight to the tick's earnings.
 */
export function besiegedIncomePerTick(
  player: PlayerState,
  allPlayers: readonly PlayerState[],
): number {
  const stacks = besiegedStacks(player, allPlayers);
  if (stacks <= 0) return 0;
  const perSecond =
    param("combat.besiegedIncomePerAttacker", COMBAT.BESIEGED_INCOME_PER_ATTACKER) * stacks;
  return perSecond / param("tick.rate", TICK.RATE);
}

/**
 * Time-scaling OUTGOING attack multiplier (Time's "Longevity", attack half):
 * grows `pct` for every `intervalTicks` of match time elapsed. 1 when the
 * player has no such passive. Unbounded. Fed into the damage pipeline as an
 * option (computed at the call site, which has match.tick).
 */
export function scalingAttackMultiplier(
  player: PlayerState,
  elapsedTicks: number,
): number {
  const elapsed = Math.max(0, elapsedTicks);
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "scalingDamageMultiplier" && p.intervalTicks > 0) {
      mult *= 1 + p.pct * Math.floor(elapsed / p.intervalTicks);
    }
  }
  return mult;
}

/**
 * Time-scaling INCOMING damage-taken multiplier (Time's "Longevity", defense
 * half): drops `pct` for every `intervalTicks` of match time elapsed, floored
 * at 0 (never negative). 1 when the player has no such passive.
 */
export function scalingDamageTakenMultiplier(
  player: PlayerState,
  elapsedTicks: number,
): number {
  const elapsed = Math.max(0, elapsedTicks);
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "scalingDamageReduction" && p.intervalTicks > 0) {
      mult *= Math.max(0, 1 - p.pct * Math.floor(elapsed / p.intervalTicks));
    }
  }
  return mult;
}

/**
 * The bonus-citizen-on-purchase passive (Time's "Time is money"), or
 * null. `chance` to grant `amount` extra citizen(s) free per hire, without
 * advancing the price ladder.
 */
export function bonusCitizenOnPurchase(
  player: PlayerState,
): { chance: number; amount: number } | null {
  for (const p of kingdomPassives(player)) {
    if (p.type === "bonusCitizenOnPurchase") {
      return { chance: p.chance, amount: p.amount };
    }
  }
  return null;
}

/** Outgoing damage multiplier from passives. */
export function damageMultiplier(
  player: PlayerState,
  opponent?: PlayerState,
  element?: string,
): number {
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "damageMultiplier") {
      if (p.conditions && opponent) {
        const allMet = p.conditions.every((c) =>
          evaluateCondition(c, player, opponent, element),
        );
        if (!allMet) continue;
      }
      mult *= 1 + p.pct;
    }
  }
  return mult;
}

/** Outgoing damage multiplier against shields from passives. */
export function shieldDamageMultiplier(
  player: PlayerState,
  opponent?: PlayerState,
  element?: string,
): number {
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "shieldDamageMultiplier") {
      if (p.conditions && opponent) {
        const allMet = p.conditions.every((c) =>
          evaluateCondition(c, player, opponent, element),
        );
        if (!allMet) continue;
      }
      mult *= 1 + p.pct;
    }
  }
  return mult;
}

/**
 * Ticks knocked off the remaining cooldown of every OTHER ability whenever this
 * player casts one (Light's "Speed of light"). 0 for kingdoms without it.
 */
export function cooldownReductionOnCast(player: PlayerState): number {
  let ticks = 0;
  for (const p of kingdomPassives(player)) {
    if (p.type === "cooldownReductionOnCast") ticks += p.ticks;
  }
  return Math.max(0, ticks);
}

/**
 * Multiplier on ability UPGRADE tier prices (Light's "Bright idea"; 1 = normal).
 * Unlock prices are the "Great Merchants" perk's business, not this.
 */
export function upgradeCostMultiplier(player: PlayerState): number {
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "upgradeCostReduction") mult *= Math.max(0, 1 - p.pct);
  }
  return mult;
}

/** Whether this player's perks run at their boosted magnitudes (Dark's
 *  "Black Magic"). */
export function hasBoostedPerks(player: PlayerState): boolean {
  return kingdomPassives(player).some((p) => p.type === "boostedPerks");
}

/**
 * Chance (0–1) that an incoming attack misses this player outright BECAUSE
 * they are currently shielded (Joker's "Why so serious?"). 0 when unshielded,
 * or for kingdoms without the passive — so the roll is skipped entirely.
 */
export function shieldedMissChance(player: PlayerState): number {
  if (player.castle.shield <= 0) return 0;
  let pct = 0;
  for (const p of kingdomPassives(player)) {
    if (p.type === "shieldedMissChance") pct += p.pct;
  }
  return Math.min(1, Math.max(0, pct));
}

/** Whether this player's attacks may be cast with multiple explicit targets —
 *  permanently via a passive (Air's "Embrace of Winds") or temporarily via a
 *  status (Dark's Infinitum tenebrae). */
export function canMultiTargetAttacks(player: PlayerState): boolean {
  return multiTargetLimit(player) > 1;
}

/** Maximum enemies one of this player's attacks may strike at once. Air's
 *  "Embrace of Winds" grants 3 (5 upgraded) permanently; a status may grant its
 *  own. The most generous source wins. 1 when nothing grants it. */
export function multiTargetLimit(player: PlayerState): number {
  let limit = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "multiTargetAttacks") {
      limit = Math.max(limit, Math.round(p.maxTargets));
    }
  }
  for (const s of player.statuses) {
    if (s.grantsMultiTarget) {
      limit = Math.max(limit, Math.round(s.grantsMultiTarget));
    }
  }
  return Math.max(1, limit);
}

/** Whether a multi-target attack from this player divides its damage across the
 *  kingdoms struck. Air spreads; Dark's Infinitum tenebrae does not. */
export function splitsMultiTargetDamage(player: PlayerState): boolean {
  return !player.statuses.some((s) => s.noDamageSpread);
}

/** Statuses the bearer's attacks currently inflict on their victims, granted by
 *  an active status rather than a passive (Dark's Infinitum tenebrae). */
export function attackInflictedStatuses(
  player: PlayerState,
): { status: StatusEffectDefinition; durationTicks: number }[] {
  const out: { status: StatusEffectDefinition; durationTicks: number }[] = [];
  for (const s of player.statuses) {
    if (s.attackInflicts) out.push(s.attackInflicts);
  }
  return out;
}

/** Chance (0–1) that an attack on this player is redirected to another
 *  kingdom, the attacker included (Air's "A Gust of Envy", Epic 8). */
export function attackRedirectChance(player: PlayerState): number {
  let pct = 0;
  for (const p of kingdomPassives(player)) {
    if (p.type === "attackRedirectChance") {
      pct += p.pct;
    }
  }
  return pct;
}

/** Multiplier on attack cooldowns (Electricity's "Don't Blink", Epic 10;
 *  1 = normal). */
export function attackCooldownMultiplier(player: PlayerState): number {
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "attackCooldownReduction") {
      mult *= Math.max(0, 1 - p.pct);
    }
  }
  return mult;
}

/** Chance/magnitude of bonus damage after an attack hits (Electricity's
 *  "AfterShock", Epic 10), or null when the kingdom has none. */
export function attackAftershock(
  player: PlayerState,
): { chance: number; pct: number } | null {
  for (const p of kingdomPassives(player)) {
    if (p.type === "attackAftershock") {
      return { chance: p.chance, pct: p.pct };
    }
  }
  return null;
}

/** On-hit status procs this player's attacks can inflict (Ice's
 *  "Cold Embrace", Epic 11). */
export function onHitStatuses(
  player: PlayerState,
): Extract<KingdomPassive, { type: "onHitStatus" }>[] {
  const procs: Extract<KingdomPassive, { type: "onHitStatus" }>[] = [];
  for (const p of kingdomPassives(player)) {
    if (p.type === "onHitStatus") procs.push(p);
  }
  return procs;
}

/** Retaliation status procs attackers of this player risk (Ice's
 *  "Frostbite", Epic 11). */
export function retaliations(
  player: PlayerState,
): Extract<KingdomPassive, { type: "retaliation" }>[] {
  const procs: Extract<KingdomPassive, { type: "retaliation" }>[] = [];
  for (const p of kingdomPassives(player)) {
    if (p.type === "retaliation") procs.push(p);
  }
  return procs;
}

/** Thorns-style reflection procs attackers of this player risk (Nature's
 *  "No Rose Without Thorns", Epic 12). */
export function thornsProcs(
  player: PlayerState,
): Extract<KingdomPassive, { type: "thorns" }>[] {
  const procs: Extract<KingdomPassive, { type: "thorns" }>[] = [];
  for (const p of kingdomPassives(player)) {
    if (p.type === "thorns") procs.push(p);
  }
  return procs;
}

/** Fraction of ability damage dealt that returns to the caster as shield
 *  (Earth's "Distraught", Epic 9). */
export function shieldOnDamageDealt(player: PlayerState): number {
  let pct = 0;
  for (const p of kingdomPassives(player)) {
    if (p.type === "shieldOnDamageDealt") {
      pct += p.pct;
    }
  }
  return pct;
}

/** Flat bonus to critical strike chance from passives. */
export function critChanceModifier(player: PlayerState): number {
  let modifier = 0;
  for (const p of kingdomPassives(player)) {
    if (p.type === "critChanceModifier") {
      modifier += p.pct;
    }
  }
  return modifier;
}

/** Flat bonus/multiplier to critical strike damage from passives. */
export function critDamageMultiplier(player: PlayerState): number {
  let mult = 1;
  for (const p of kingdomPassives(player)) {
    if (p.type === "critDamageMultiplier") {
      mult *= 1 + p.pct;
    }
  }
  return mult;
}

/** Overridden citizen price-ladder BASE cost (Love's "Warm Welcome": 20 vs the
 *  default 25), or null to use the default. The growth factor is unchanged, so
 *  EVERY hire is proportionally cheaper. */
export function citizenBaseCostOverride(player: PlayerState): number | null {
  for (const p of kingdomPassives(player)) {
    if (p.type === "citizenBaseCost") return p.amount;
  }
  return null;
}

/** Fraction of any OTHER kingdom's healing this player also receives, summed
 *  across passives (Love's "Feel the love!"). 0 without it. */
export function healShareGlobalPct(player: PlayerState): number {
  let pct = 0;
  for (const p of kingdomPassives(player)) {
    if (p.type === "healShareGlobal") pct += p.pct;
  }
  return pct;
}
