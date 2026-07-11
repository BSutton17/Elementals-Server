import { KINGDOM_PASSIVES, type KingdomPassive } from "../data/kingdoms.js";
import type { PlayerState } from "../match/playerState.js";
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
 *  (Water's "We're In This Together": $0.60/s per citizen vs base $0.55/s). */
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

/** Whether this player's attacks may be cast with multiple explicit targets
 *  (Air's "Embrace of Winds", Epic 8). */
export function canMultiTargetAttacks(player: PlayerState): boolean {
  return kingdomPassives(player).some((p) => p.type === "multiTargetAttacks");
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
