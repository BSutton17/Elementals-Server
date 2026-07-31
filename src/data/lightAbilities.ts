import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Light Kingdom ability set — PLACEHOLDER DATA.
 *
 * The kit's identity is not designed yet. Everything here is a deliberately
 * plain, working stand-in on the shared frameworks so the kingdom is fully
 * playable end to end (selectable, castable, upgradable, synced) while its real
 * abilities are written. Replace the names, magnitudes, and effects in place —
 * nothing outside this file needs to change when the real kit lands, except the
 * matching client metadata in `Client/src/game/abilities.ts`.
 *
 * The shape follows every other kingdom: basic attack (Q), medium attack (E),
 * heavy attack (F), self utility (R), and an ultimate (Space), each with a
 * three-step upgrade path (damage → cooldown/cost → damage).
 *
 * Passives are `KINGDOM_PASSIVES.light` (also placeholders).
 */

/** Placeholder self-buff granted by LightAbility4. */
export const LIGHT_UTILITY_STATUS: StatusEffectDefinition = {
  id: "lightAbility4",
  name: "LightAbility4",
  category: "buff",
  stacking: "refresh",
  // A modest flat damage-reduction buff — a real effect so the utility slot is
  // exercised, with nothing kingdom-defining about it.
  modifiers: [{ stat: "damageTaken", op: "mult", value: 0.85 }],
};

/** LightAbility1 (basic): the reliable "Q". */
export const LIGHT_ABILITY_1: AbilityDefinition = {
  id: "lightAbility1",
  name: "LightAbility1",
  kind: "attack",
  cost: 100,
  cooldownTicks: 3 * TICK.RATE, // 3 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 250, element: "light" } },
  ],
  upgradePath: [
    { level: 1, cost: 150, changes: { effectParams: [{ amount: 300 }] } },
    {
      level: 2,
      cost: 250,
      changes: {
        cooldownTicks: Math.round(3 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    { level: 3, cost: 400, changes: { effectParams: [{ amount: 400 }] } },
  ],
};

/** LightAbility2 (medium attack). */
export const LIGHT_ABILITY_2: AbilityDefinition = {
  id: "lightAbility2",
  name: "LightAbility2",
  kind: "attack",
  cost: 250,
  cooldownTicks: 10 * TICK.RATE, // 10 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 400, element: "light" } },
  ],
  upgradePath: [
    { level: 1, cost: 200, changes: { effectParams: [{ amount: 500 }] } },
    {
      level: 2,
      cost: 300,
      changes: {
        cooldownTicks: Math.round(10 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    { level: 3, cost: 400, changes: { effectParams: [{ amount: 600 }] } },
  ],
};

/** LightAbility3 (heavy attack). */
export const LIGHT_ABILITY_3: AbilityDefinition = {
  id: "lightAbility3",
  name: "LightAbility3",
  kind: "attack",
  cost: 500,
  cooldownTicks: 20 * TICK.RATE, // 20 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 750, element: "light" } },
  ],
  upgradePath: [
    { level: 1, cost: 500, changes: { effectParams: [{ amount: 850 }] } },
    {
      level: 2,
      cost: 600,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
    { level: 3, cost: 800, changes: { effectParams: [{ amount: 1000 }] } },
  ],
};

/** LightAbility4 (utility): a self buff. */
export const LIGHT_ABILITY_4: AbilityDefinition = {
  id: "lightAbility4",
  name: "LightAbility4",
  kind: "utility",
  cost: 150,
  cooldownTicks: 20 * TICK.RATE, // 20 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: { status: LIGHT_UTILITY_STATUS, durationTicks: 10 * TICK.RATE }, // 10 s
    },
  ],
  upgradePath: [
    { level: 1, cost: 200, changes: { effectParams: [{ durationTicks: 15 * TICK.RATE }] } },
    {
      level: 2,
      cost: 350,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
  ],
};

/** LightAbility5 (ultimate). */
export const LIGHT_ABILITY_5: AbilityDefinition = {
  id: "lightAbility5",
  name: "LightAbility5",
  kind: "ultimate",
  cost: 800,
  cooldownTicks: 90 * TICK.RATE, // 90 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 1500, element: "light" } },
  ],
  upgradePath: [
    { level: 1, cost: 1000, changes: { effectParams: [{ amount: 1800 }] } },
    {
      level: 2,
      cost: 1500,
      changes: {
        cooldownTicks: Math.round(90 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
  ],
};

/** The Light kingdom's activatable ability set. */
export const LIGHT_ABILITIES: AbilityDefinition[] = [
  LIGHT_ABILITY_1,
  LIGHT_ABILITY_2,
  LIGHT_ABILITY_3,
  LIGHT_ABILITY_4,
  LIGHT_ABILITY_5,
];
