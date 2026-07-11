import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Ice Kingdom ability set (Epic 11) — pure data on the shared frameworks.
 * Ice's passives ("Frostbite" retaliation production slow, "Cold Embrace" 10%
 * freeze on hit — plus its Burn weakness) live in KINGDOM_PASSIVES
 * (kingdoms.ts), referencing the statuses defined here.
 *
 * NOTE: costs, cooldowns, damage numbers, and durations are initial defaults
 * (the design specifies mechanics, not magnitudes except where noted) —
 * expected to move in later balance tickets.
 */

/** Frozen: the bearer cannot attack (design: 4 seconds). */
export const FROZEN_STATUS: StatusEffectDefinition = {
  id: "frozen",
  name: "Frozen",
  category: "crowdControl",
  stacking: "refresh",
  blocksAttacks: true,
};

/** The standard Frozen duration (design: "cannot attack for 4 seconds"). */
export const FROZEN_DURATION = 4 * TICK.RATE;

/** Frostbite: the bearer's production is slowed by 50% (Ice's retaliation). */
export const FROSTBITE_STATUS: StatusEffectDefinition = {
  id: "frostbite",
  name: "Frostbite",
  category: "debuff",
  stacking: "refresh",
  modifiers: [
    { stat: "income", op: "mult", value: 0.5 },
  ],
};

/** Chilling Retribution: cooldowns the bearer arms are 30% longer. */
export const CHILLING_RETRIBUTION_STATUS: StatusEffectDefinition = {
  id: "chillingRetribution",
  name: "Chilling Retribution",
  category: "debuff",
  stacking: "refresh",
  modifiers: [
    // The global cooldown stat setCooldown applies (ticket #107).
    { stat: "cooldown", op: "mult", value: 1.3 },
  ],
};

/** Chilling Retribution (Lv 5): increased cooldown penalty (30% -> 45%). */
export const CHILLING_RETRIBUTION_STATUS_LV5: StatusEffectDefinition = {
  ...CHILLING_RETRIBUTION_STATUS,
  modifiers: [
    { stat: "cooldown", op: "mult", value: 1.45 },
  ],
};

/** Frozen (Freeze to the Core Lv 5): thawing leaves the target's production
 *  briefly reduced — the Frostbite slow follows the Freeze on expiry. */
export const FROZEN_STATUS_LV5: StatusEffectDefinition = {
  ...FROZEN_STATUS,
  onExpireStatus: { status: FROSTBITE_STATUS, durationTicks: 3 * TICK.RATE }, // 3 s
};

/** Frozen Focus: the caster's next attacks (one per stack) have their
 *  chance-gated effects — Freeze, Chilling Retribution — guaranteed. */
export const FROZEN_FOCUS_STATUS: StatusEffectDefinition = {
  id: "frozenFocus",
  name: "Frozen Focus",
  category: "buff",
  stacking: "replace",
  guaranteesChanceEffects: true,
};

/** Blizzard: the bearer cannot attack and produces nothing. */
export const BLIZZARD_STATUS: StatusEffectDefinition = {
  id: "blizzard",
  name: "Blizzard",
  category: "crowdControl",
  stacking: "refresh",
  blocksAttacks: true,
  modifiers: [
    { stat: "income", op: "mult", value: 0 },
  ],
};

/** Icicle: basic Ice attack. */
export const ICICLE: AbilityDefinition = {
  id: "icicle",
  name: "Icicle",
  kind: "attack",
  cost: 100,
  cooldownTicks: 3 * TICK.RATE, // 3 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 250, element: "ice" },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 150,
      changes: {
        effectParams: [{ amount: 300 }],
      },
    },
    {
      level: 2,
      cost: 250,
      changes: {
        cooldownTicks: Math.round(3 * TICK.RATE * 0.9), // 54 ticks (2.7 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 3,
      cost: 400,
      changes: {
        effectParams: [{ amount: 350 }],
      },
    },
  ],
};

/** Flood of Frost: powerful Ice attack — 35% chance to apply Chilling
 *  Retribution (all the target's cooldowns +30% for a short duration). */
export const FLOOD_OF_FROST: AbilityDefinition = {
  id: "floodOfFrost",
  name: "Flood of Frost",
  kind: "attack",
  cost: 250,
  cooldownTicks: 10 * TICK.RATE, // 10 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 450, element: "ice" },
    },
    {
      type: "status",
      target: "target",
      params: { status: CHILLING_RETRIBUTION_STATUS, durationTicks: 6 * TICK.RATE }, // 6 s
      chance: 0.35,
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 200,
      changes: {
        effectParams: [{ amount: 550 }],
      },
    },
    {
      level: 2,
      cost: 300,
      changes: {
        effectParams: [null, { durationTicks: 9 * TICK.RATE }], // 6 s -> 9 s
      },
    },
    {
      level: 3,
      cost: 450,
      changes: {
        cooldownTicks: Math.round(10 * TICK.RATE * 0.9), // 9 s
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 600,
      changes: {
        effectParams: [null, { status: CHILLING_RETRIBUTION_STATUS_LV5 }], // +30% -> +45%
      },
    },
  ],
};

/** Freeze to the Core: guarantees the target becomes Frozen (no attacks, 4 s). */
export const FREEZE_TO_THE_CORE: AbilityDefinition = {
  id: "freezeToTheCore",
  name: "Freeze to the Core",
  kind: "attack",
  cost: 400,
  cooldownTicks: 20 * TICK.RATE, // 20 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 300, element: "ice" },
    },
    {
      type: "status",
      target: "target",
      params: { status: FROZEN_STATUS, durationTicks: FROZEN_DURATION }, // guaranteed
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 300,
      changes: {
        effectParams: [{ amount: 400 }],
      },
    },
    {
      level: 2,
      cost: 450,
      changes: {
        effectParams: [null, { durationTicks: 6 * TICK.RATE }], // freeze 4 s -> 6 s
      },
    },
    {
      level: 3,
      cost: 600,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.9), // 18 s
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 800,
      changes: {
        // Thawing leaves production briefly reduced (Frostbite follows).
        effectParams: [null, { status: FROZEN_STATUS_LV5 }],
      },
    },
  ],
};

/** Frozen Focus: Ice utility — your next two Ice attacks are guaranteed to
 *  Freeze or cause Chilling Retribution (their chance procs always land). */
export const FROZEN_FOCUS: AbilityDefinition = {
  id: "frozenFocus",
  name: "Frozen Focus",
  kind: "utility",
  cost: 200,
  cooldownTicks: 25 * TICK.RATE, // 25 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: {
        status: FROZEN_FOCUS_STATUS,
        durationTicks: 30 * TICK.RATE, // generous window; stacks gate usage
        stacks: 2, // one per attack
      },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 300,
      changes: {
        effectParams: [{ durationTicks: 45 * TICK.RATE }], // window 30 s -> 45 s
      },
    },
    {
      level: 2,
      cost: 450,
      changes: {
        cooldownTicks: Math.round(25 * TICK.RATE * 0.85), // 425 ticks (21.25 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** Blizzard: ultimate — every opposing kingdom cannot attack and has its
 *  production frozen for 7 seconds. */
export const BLIZZARD: AbilityDefinition = {
  id: "blizzard",
  name: "Blizzard",
  kind: "ultimate",
  cost: 1000,
  cooldownTicks: 90 * TICK.RATE, // 90 s
  targeting: { mode: "allEnemies" },
  effects: [
    {
      type: "status",
      target: "target",
      params: { status: BLIZZARD_STATUS, durationTicks: 7 * TICK.RATE }, // 7 s
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 1000,
      changes: {
        effectParams: [{ durationTicks: 9 * TICK.RATE }], // 7 s -> 9 s
      },
    },
    {
      level: 2,
      cost: 1500,
      changes: {
        cooldownTicks: Math.round(90 * TICK.RATE * 0.85), // 1530 ticks (76.5 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** The Ice kingdom's activatable ability set. */
export const ICE_ABILITIES: AbilityDefinition[] = [
  ICICLE,
  FLOOD_OF_FROST,
  FREEZE_TO_THE_CORE,
  FROZEN_FOCUS,
  BLIZZARD,
];
