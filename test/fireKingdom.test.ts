import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";
import {
  activateAbility,
  resolveAbility,
  type AbilityDefinition,
} from "../src/engine/abilities.js";
import { earn } from "../src/engine/money.js";
import { applyStatus, getStatus, processStatusTicks } from "../src/engine/status.js";
import { FIREBALL, SCORCHING_SUN, FIRENADO, BURN_STATUS, HEAT_WAVE, BLAZING_DETERMINATION } from "../src/data/fireAbilities.js";

const player = (id: string, kingdomId: string = "fire"): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

function activeMatch(
  kingdomA: string = "fire",
  kingdomB: string = "plains"
): { match: Match; a: PlayerState; b: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(player("a", kingdomA));
  match.addPlayer(player("b", kingdomB));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const [a, b] = [gs.getPlayer("a")!, gs.getPlayer("b")!];
  earn(a, 10_000);
  earn(b, 10_000);
  return { match, a, b };
}

// --- [#111] Fire Passives ---------------------------------------------------------

test("Set Your Heart Ablaze! configures starting castle HP to 8500 and increases damage by 15%", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  // Verify starting HP/maxHp for Fire is 8500
  assert.equal(a.castle.hp, 8500);
  assert.equal(a.castle.maxHp, 8500);

  // Cast Fireball (base damage 250)
  // Base 250 * 1.15 = 287.5 -> rounded to 288
  b.castle.hp = 10_000;
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 288);
});

test("Roast! deals 1.25x damage to shields", () => {
  const { match, a, b } = activeMatch("fire", "water");

  const strike: AbilityDefinition = {
    id: "strike",
    kind: "attack",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [{ type: "damage", target: "target", params: { amount: 1000 } }],
  };

  // Attacking target with shield
  // Base 1000 * 1.15 (damageMultiplier) = 1150
  // Target has shield -> multiplied by Roast! 1.25 = 1150 * 1.25 = 1437.5 -> rounded to 1438
  b.castle.hp = 10_000;
  b.castle.shield = 2000;
  activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.shield, 2000 - 1438);
});

// --- [#113] Burn Status DoT -------------------------------------------------------

test("Burn status ticks damage over time based on stack count", () => {
  const { match, a, b } = activeMatch();

  // Apply 1 stack of Burn
  applyStatus(b, BURN_STATUS, { sourceId: "a", durationTicks: 50, stacks: 1 });
  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 20); // 20 damage per tick per stack

  // Apply 3 stacks of Burn
  b.statuses = [];
  applyStatus(b, BURN_STATUS, { sourceId: "a", durationTicks: 50, stacks: 3 });
  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 60); // 60 damage per tick per stack (20 * 3)
});

// --- [#112] Fire Attacks & Synergies ----------------------------------------------

test("Scorching Sun applies Burn directly, and deals bonus damage to burning targets", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  // Cast Scorching Sun
  // Base 450 * 1.15 = 517.5 -> rounded to 518
  b.castle.hp = 10_000;
  activateAbility(match, a, SCORCHING_SUN, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 518);

  // Target should have Burn status now
  const burn = getStatus(b, "burn");
  assert.ok(burn);
  assert.equal(burn.remainingTicks, 100); // 5 seconds (100 ticks)

  // Cast Scorching Sun again on target who is already burning
  // Base 450 + 200 (burn bonus) = 650
  // Multiplied by 1.15 (Set Your Heart Ablaze!) = 747.5 -> rounded to 748
  // Amplified by Burn (fire attacks from the applier): 748 * 1.25 = 935
  b.castle.hp = 10_000;
  a.cooldowns = {};
  activateAbility(match, a, SCORCHING_SUN, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 935);
});

test("Burn amplifies Fire attacks from the applier only", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  // Burn applied by a: a's Fire attacks deal 1.25x damage to b.
  applyStatus(b, BURN_STATUS, { sourceId: "a", durationTicks: 1000 });
  b.castle.hp = 10_000;
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  // 250 * 1.15 (passive) = 287.5 -> 288, amplified: 288 * 1.25 = 360
  assert.equal(b.castle.hp, 10_000 - 360);

  // A Burn applied by someone else does not amplify a's attacks.
  b.statuses = [];
  b.modifiers = [];
  applyStatus(b, BURN_STATUS, { sourceId: "b", durationTicks: 1000 });
  b.castle.hp = 10_000;
  a.cooldowns = {};
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 288); // unamplified
});

test("Firenado has a 50% chance to apply Burn", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  // RNG below 0.50 succeeds
  b.statuses = [];
  activateAbility(match, a, FIRENADO, { targetId: "b", rng: () => 0.40 });
  assert.ok(getStatus(b, "burn"));

  // RNG above 0.50 fails
  b.statuses = [];
  activateAbility(match, a, FIRENADO, { targetId: "b", rng: () => 0.60 });
  assert.ok(!getStatus(b, "burn"));
});

test("Fireball is a plain attack and does not apply Burn", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  // Fireball only deals damage; Burn comes from Scorching Sun / Firenado.
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  assert.ok(!getStatus(b, "burn"));
});

test("Ice players suffer 1.5x longer Burn durations", () => {
  const { match, a, b } = activeMatch("fire", "ice");

  // Scorching Sun applies Burn for 100 ticks (5 seconds);
  // Ice player b should take Burn for 100 * 1.5 = 150 ticks
  activateAbility(match, a, SCORCHING_SUN, { targetId: "b", forceCrit: false });
  const burn = getStatus(b, "burn");
  assert.ok(burn);
  assert.equal(burn.remainingTicks, 150);
});

// --- [#113] Heat Wave & [#114] Blazing Determination --------------------------------

test("Heat Wave applies stats and refreshes duration without stacking", () => {
  const { match, a } = activeMatch("fire", "plains");

  // Cast Heat Wave
  activateAbility(match, a, HEAT_WAVE, { targetId: "a" });
  const status = getStatus(a, "heatWave");
  assert.ok(status);
  assert.equal(status.remainingTicks, 300); // 15 seconds

  // Verify modifiers are active
  const chance = a.modifiers.find((m) => m.stat === "critChance" && m.sourceId === "status:heatWave");
  const mult = a.modifiers.find((m) => m.stat === "critMultiplier" && m.sourceId === "status:heatWave");
  assert.ok(chance);
  assert.equal(chance.value, 0.05);
  assert.ok(mult);
  assert.equal(mult.value, 0.10);

  // Cast again mid-duration -> should refresh ticks to 300 and not add extra modifiers
  status.remainingTicks = 150;
  a.cooldowns = {};
  activateAbility(match, a, HEAT_WAVE, { targetId: "a" });
  assert.equal(status.remainingTicks, 300);
  assert.equal(a.modifiers.filter((m) => m.sourceId === "status:heatWave").length, 2);
});

test("Blazing Determination multiplies next attack damage by 2.5x and gets consumed", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  // Cast Blazing Determination
  activateAbility(match, a, BLAZING_DETERMINATION, { targetId: "a" });
  assert.ok(getStatus(a, "blazingDetermination"));

  // Cast Fireball (base 250)
  // Base 250 * 1.15 (passive) * 2.50 (Blazing Determination) = 718.75 -> rounded to 719
  b.castle.hp = 10_000;
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 719);

  // Status and modifiers should be consumed/removed instantly
  assert.ok(!getStatus(a, "blazingDetermination"));
  assert.equal(a.modifiers.filter((m) => m.sourceId === "status:blazingDetermination").length, 0);

  // Subsequent attack deals normal damage (base 250 * 1.15 = 288)
  b.castle.hp = 10_000;
  a.cooldowns = {}; // clear fireball CD
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 288);
});

// --- Fire Ability Upgrades --------------------------------------------------------

test("Fireball upgrades modify damage and cooldown values", () => {
  // Lv 1 (Default): Damage 250, CD 60 (3s)
  const lv1 = resolveAbility(FIREBALL, 0);
  assert.equal(lv1.effects[0].params.amount, 250);
  assert.equal(lv1.cooldownTicks, 60);

  // Lv 2: Increased damage (350)
  const lv2 = resolveAbility(FIREBALL, 1);
  assert.equal(lv2.effects[0].params.amount, 350);
  assert.equal(lv2.cooldownTicks, 60);

  // Lv 3: Reduce cooldown by 10% (54 ticks)
  const lv3 = resolveAbility(FIREBALL, 2);
  assert.equal(lv3.effects[0].params.amount, 350);
  assert.equal(lv3.cooldownTicks, 54);

  // Lv 4: Increased damage (450)
  const lv4 = resolveAbility(FIREBALL, 3);
  assert.equal(lv4.effects[0].params.amount, 450);
  assert.equal(lv4.cooldownTicks, 54);
});

test("Scorching Sun upgrades modify damage, burn duration, cooldown, and bonus damage", () => {
  // Lv 1 (Default): Damage 450, Burn duration 100 (5s), CD 160 (8s), bonus damage 200
  const lv1 = resolveAbility(SCORCHING_SUN, 0);
  assert.equal(lv1.effects[0].params.amount, 450);
  assert.equal(lv1.effects[1].params.durationTicks, 100);
  assert.equal(lv1.cooldownTicks, 160);
  assert.equal(lv1.effects[0].params.bonusDamageIfTargetHasStatus?.extraAmount, 200);

  // Lv 2: Increased damage (550)
  const lv2 = resolveAbility(SCORCHING_SUN, 1);
  assert.equal(lv2.effects[0].params.amount, 550);

  // Lv 3: Burn duration increased (7s -> 140 ticks)
  const lv3 = resolveAbility(SCORCHING_SUN, 2);
  assert.equal(lv3.effects[1].params.durationTicks, 140);

  // Lv 4: Cooldown reduced 10% (144 ticks)
  const lv4 = resolveAbility(SCORCHING_SUN, 3);
  assert.equal(lv4.cooldownTicks, 144);

  // Lv 5: Increased bonus damage against Burning targets (350)
  const lv5 = resolveAbility(SCORCHING_SUN, 4);
  assert.equal(lv5.effects[0].params.bonusDamageIfTargetHasStatus?.extraAmount, 350);
});

test("Firenado upgrades modify damage, burn chance, cooldown, and burn duration", () => {
  // Lv 1 (Default): Damage 800, chance 0.50, CD 240 (12s), burn duration 100 (5s)
  const lv1 = resolveAbility(FIRENADO, 0);
  assert.equal(lv1.effects[0].params.amount, 800);
  assert.equal(lv1.effects[1].chance, 0.50);
  assert.equal(lv1.cooldownTicks, 240);
  assert.equal(lv1.effects[1].params.durationTicks, 100);

  // Lv 2: Increased damage (1000)
  const lv2 = resolveAbility(FIRENADO, 1);
  assert.equal(lv2.effects[0].params.amount, 1000);

  // Lv 3: Burn chance increased (0.75)
  const lv3 = resolveAbility(FIRENADO, 2);
  assert.equal(lv3.effects[1].chance, 0.75);

  // Lv 4: Cooldown reduced 10% (216 ticks)
  const lv4 = resolveAbility(FIRENADO, 3);
  assert.equal(lv4.cooldownTicks, 216);

  // Lv 5: Increased Burn duration (160 ticks)
  const lv5 = resolveAbility(FIRENADO, 4);
  assert.equal(lv5.effects[1].params.durationTicks, 160);
});

test("Heat Wave upgrades swap status modifiers for Crit Chance and Crit Damage", () => {
  // Lv 1 (Default): +5% Crit Chance, +10% Crit Damage
  const lv1 = resolveAbility(HEAT_WAVE, 0);
  const status1 = lv1.effects[0].params.status!;
  assert.equal(status1.modifiers?.[0].value, 0.05);
  assert.equal(status1.modifiers?.[1].value, 0.10);

  // Lv 2: Increase Crit Chance (+7.5%)
  const lv2 = resolveAbility(HEAT_WAVE, 1);
  const status2 = lv2.effects[0].params.status!;
  assert.equal(status2.modifiers?.[0].value, 0.075);
  assert.equal(status2.modifiers?.[1].value, 0.10);

  // Lv 3: Increase Crit Damage (+15%)
  const lv3 = resolveAbility(HEAT_WAVE, 2);
  const status3 = lv3.effects[0].params.status!;
  assert.equal(status3.modifiers?.[0].value, 0.075);
  assert.equal(status3.modifiers?.[1].value, 0.15);
});

test("Blazing Determination upgrades swap status multiplier and reduce cooldown", () => {
  // Lv 1 (Default): 2.5x next attack, 20s cooldown
  const lv1 = resolveAbility(BLAZING_DETERMINATION, 0);
  const status1 = lv1.effects[0].params.status!;
  assert.equal(status1.modifiers?.[0].value, 2.50);
  assert.equal(lv1.cooldownTicks, 400);

  // Lv 2: Increase damage multiplier to 2.75x
  const lv2 = resolveAbility(BLAZING_DETERMINATION, 1);
  const status2 = lv2.effects[0].params.status!;
  assert.equal(status2.modifiers?.[0].value, 2.75);
  assert.equal(lv2.cooldownTicks, 400);

  // Lv 3: Reduce cooldown to 15s (300 ticks)
  const lv3 = resolveAbility(BLAZING_DETERMINATION, 2);
  assert.equal(lv3.cooldownTicks, 300);
});
