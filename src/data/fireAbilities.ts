import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Fire attacks from the Burn's applier deal this multiplier against the
 * burning target (initial default — expected to move in balance tickets).
 */
const BURN_FIRE_AMP = 1.25;

/**
 * Reusable Burn Status effect (ticket #113). Burn does two things:
 *  - DoT: 20 damage per tick per stack, capping at 5 stacks;
 *  - amplification: while burning, Fire attacks *from the player who applied
 *    the Burn* deal ×1.25 damage (a conditional damageTaken modifier gated on
 *    the attack's element and the Burn's source).
 */
export const BURN_STATUS: StatusEffectDefinition = {
  id: "burn",
  name: "Burn",
  category: "debuff",
  stacking: "stack",
  maxStacks: 3,
  tickEffects: [
    {
      type: "damage",
      amount: 10,
      perStack: true,
    },
  ],
  modifiers: [
    {
      stat: "damageTaken",
      op: "mult",
      value: BURN_FIRE_AMP,
      conditions: [
        { type: "attackElement", params: { element: "fire" } },
        { type: "targetHasStatusFromCaster", params: { statusId: "burn" } },
      ],
    },
  ],
};

/** Fireball: basic Fire attack (ticket #112). */
export const FIREBALL: AbilityDefinition = {
  id: "fireball",
  name: "Fireball",
  kind: "attack",
  cost: 125,
  cooldownTicks: 3 * TICK.RATE, // 3 s
  targeting: { mode: "singleEnemy" },
  // A plain damage attack — Burn is applied only by Scorching Sun (guaranteed)
  // and Firenado (chance); the Burn status itself carries the extra damage.
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 250, element: "fire" },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 250,
      changes: {
        effectParams: [{ amount: 300 }],
      },
    },
    {
      level: 2,
      cost: 300,
      changes: {
        cooldownTicks: Math.round(3 * TICK.RATE * 0.9), // 54 ticks (2.7 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 3,
      cost: 350,
      changes: {
        effectParams: [{ amount: 350 }],
      },
    },
  ],
};

/** Scorching Sun: powerful Fire attack with burn synergy (ticket #112). */
export const SCORCHING_SUN: AbilityDefinition = {
  id: "scorchingSun",
  name: "Scorching Sun",
  kind: "attack",
  cost: 300,
  cooldownTicks: 8 * TICK.RATE, // 8 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: {
        amount: 300,
        element: "fire",
        bonusDamageIfTargetHasStatus: { statusId: "burn", extraAmount: 100 },
      },
    },
    {
      type: "status",
      target: "target",
      params: { status: BURN_STATUS, durationTicks: 5 * TICK.RATE }, // 5 s
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 350,
      changes: {
        effectParams: [{ amount: 400 }],
      },
    },
    {
      level: 2,
      cost: 450,
      changes: {
        effectParams: [null, { durationTicks: 7 * TICK.RATE }], // burn duration 5s -> 7s (140 ticks)
      },
    },
    {
      level: 3,
      cost: 550,
      changes: {
        cooldownTicks: Math.round(8 * TICK.RATE * 0.9), // 144 ticks (7.2 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 600,
      changes: {
        effectParams: [
          { bonusDamageIfTargetHasStatus: { statusId: "burn", extraAmount: 350 } },
        ],
      },
    },
  ],
};

/** Firenado: very powerful chance-based Fire attack (ticket #112). */
export const FIRENADO: AbilityDefinition = {
  id: "firenado",
  name: "Firenado",
  kind: "attack",
  cost: 450,
  cooldownTicks: 20 * TICK.RATE, // 12 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 500, element: "fire" },
    },
    {
      type: "status",
      target: "target",
      params: { status: BURN_STATUS, durationTicks: 5 * TICK.RATE }, // 5 s
      chance: 0.50,
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 300,
      changes: {
        effectParams: [{ amount: 600 }],
      },
    },
    {
      level: 2,
      cost: 350,
      changes: {
        effectChances: [null, 0.75],
      },
    },
    {
      level: 3,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(12 * TICK.RATE * 0.9), // 216 ticks (10.8 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 500,
      changes: {
        effectParams: [null, { durationTicks: 8 * TICK.RATE }], // burn duration 5s -> 8s (160 ticks)
      },
    },
  ],
};

/** Heat Wave status effect (ticket #113). */
export const HEAT_WAVE_STATUS: StatusEffectDefinition = {
  id: "heatWave",
  name: "Heat Wave",
  category: "buff",
  stacking: "refresh",
  modifiers: [
    {
      stat: "critChance",
      op: "add",
      value: 0.05,
    },
    {
      stat: "critMultiplier",
      op: "add",
      value: 0.10,
    },
  ],
};

/** Heat Wave status effect (Lv 2). */
export const HEAT_WAVE_STATUS_LV2: StatusEffectDefinition = {
  ...HEAT_WAVE_STATUS,
  modifiers: [
    {
      stat: "critChance",
      op: "add",
      value: 0.075,
    },
    {
      stat: "critMultiplier",
      op: "add",
      value: 0.10,
    },
  ],
};

/** Heat Wave status effect (Lv 3). */
export const HEAT_WAVE_STATUS_LV3: StatusEffectDefinition = {
  ...HEAT_WAVE_STATUS,
  modifiers: [
    {
      stat: "critChance",
      op: "add",
      value: 0.075,
    },
    {
      stat: "critMultiplier",
      op: "add",
      value: 0.15,
    },
  ],
};

/** Heat Wave: Fire utility self-buff (ticket #113). */
export const HEAT_WAVE: AbilityDefinition = {
  id: "heatWave",
  name: "Heat Wave",
  kind: "utility",
  cost: 100,
  cooldownTicks: 15 * TICK.RATE, // 15s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: { status: HEAT_WAVE_STATUS, durationTicks: 15 * TICK.RATE },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 200,
      changes: {
        effectParams: [{ status: HEAT_WAVE_STATUS_LV2 }],
      },
    },
    {
      level: 2,
      cost: 350,
      changes: {
        effectParams: [{ status: HEAT_WAVE_STATUS_LV3 }],
      },
    },
  ],
};

/** Blazing Determination status effect (ticket #114). */
export const BLAZING_DETERMINATION_STATUS: StatusEffectDefinition = {
  id: "blazingDetermination",
  name: "Blazing Determination",
  category: "buff",
  stacking: "replace",
  modifiers: [
    {
      stat: "damage",
      op: "mult",
      value: 2.25,
      usageLimit: 1,
    },
  ],
};

/** Blazing Determination status effect (Lv 2). */
export const BLAZING_DETERMINATION_STATUS_LV2: StatusEffectDefinition = {
  ...BLAZING_DETERMINATION_STATUS,
  modifiers: [
    {
      stat: "damage",
      op: "mult",
      value: 2.5,
      usageLimit: 1,
    },
  ],
};

/** Blazing Determination: Fire utility/ultimate self-buff (ticket #114). */
export const BLAZING_DETERMINATION: AbilityDefinition = {
  id: "blazingDetermination",
  name: "Blazing Determination",
  kind: "utility",
  cost: 750,
  cooldownTicks: 35 * TICK.RATE, // 30s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: { status: BLAZING_DETERMINATION_STATUS, durationTicks: 30 * TICK.RATE },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 350,
      changes: {
        effectParams: [{ status: BLAZING_DETERMINATION_STATUS_LV2 }],
      },
    },
    {
      level: 2,
      cost: 450,
      changes: {
        cooldownTicks: 15 * TICK.RATE, // 15 s
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** The Fire kingdom's activatable ability set. */
export const FIRE_ABILITIES: AbilityDefinition[] = [
  FIREBALL,
  SCORCHING_SUN,
  FIRENADO,
  HEAT_WAVE,
  BLAZING_DETERMINATION,
];
