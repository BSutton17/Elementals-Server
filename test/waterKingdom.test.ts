import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_STATUS,
  FLOOD,
  FLUID_ASSIMILATION,
  RIPTIDE,
  WATERFALL,
  WATER_BALL,
} from "../src/data/waterAbilities.js";
import { activateAbility, purchaseUpgrade } from "../src/engine/abilities.js";
import { getCooldown } from "../src/engine/cooldowns.js";
import { applyStatus, getStatus, hasStatus } from "../src/engine/status.js";
import { resolveDamage } from "../src/engine/damage.js";
import { applyPassiveIncome, computeIncome } from "../src/engine/economy.js";
import { earn } from "../src/engine/money.js";
import { selectTarget } from "../src/engine/targeting.js";
import { tickMatch } from "../src/engine/tick.js";
import { TICK } from "../src/data/balance.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { KingdomId } from "../src/data/kingdoms.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

const player = (id: string, kingdomId: KingdomId): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** water (w) vs fire (f) vs air (n — neutral bystander). */
function pond(): { match: Match; w: PlayerState; f: PlayerState; n: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(player("w", "water"));
  match.addPlayer(player("f", "plains"));
  match.addPlayer(player("n", "air"));
  match.hostId = "w";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const [w, f, n] = [gs.getPlayer("w")!, gs.getPlayer("f")!, gs.getPlayer("n")!];
  for (const p of [w, f, n]) earn(p, 10_000);
  return { match, w, f, n };
}

// --- #81: passives applied automatically by the engine -------------------------

test("We're In This Together: water citizens produce $0.60/s vs the base $0.55/s", () => {
  const { w, f } = pond();
  // 10 citizens: water 10 × $0.03/tick = $0.3; Fire 10 × $0.0275 = $0.275.
  assert.equal(computeIncome(w), 0.3);
  assert.equal(computeIncome(f), 0.275);

  w.economy.citizens = 20; // flat per-citizen rate: 20 × 0.03
  assert.equal(computeIncome(w), 0.6);
});

test("production passive flows through the real income phase", () => {
  const { match, w, f } = pond();
  const w0 = w.economy.currency;
  const f0 = f.economy.currency;
  applyPassiveIncome(match.gameState!);
  assert.ok(Math.abs((w.economy.currency - w0) - 0.3) < 0.0001); // floating point tolerance
  assert.ok(Math.abs((f.economy.currency - f0) - 0.275) < 0.0001); // floating point tolerance
});

test("Fountain of Youth: burn lasts 40% shorter on Water — and only on Water", () => {
  const { w, f } = pond();
  const burn = { id: "burn", category: "debuff" as const, stacking: "refresh" as const };
  assert.equal(applyStatus(w, burn, { sourceId: "f", durationTicks: 100 }).remainingTicks, 60);
  assert.equal(applyStatus(f, burn, { sourceId: "w", durationTicks: 100 }).remainingTicks, 100);
  // Other statuses on Water are unaffected.
  assert.equal(
    applyStatus(w, CURRENT_STATUS, { sourceId: "f", durationTicks: 100 }).remainingTicks,
    100,
  );
});

test("Fountain of Youth: 15% less damage from Fire attacks — other elements full", () => {
  const { w, f } = pond();
  const fire = resolveDamage(f, w, 400, { element: "fire", forceCrit: false });
  assert.equal(fire.amount, 340); // 400 × 0.85

  const neutral = resolveDamage(f, w, 400, { forceCrit: false });
  assert.equal(neutral.amount, 400); // element unknown → no resistance

  // And fire into a non-Water kingdom is not reduced.
  const intoFire = resolveDamage(w, f, 400, { element: "fire", forceCrit: false });
  assert.equal(intoFire.amount, 400);
});

// --- #82: Water Ball -------------------------------------------------------------

test("Water Ball is a working attack on the shared framework", () => {
  const { match, w, f } = pond();
  const r = activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10_000 - 250);
});

// --- #83: the Current status -------------------------------------------------------

test("Current tracks duration and expires through the tick loop", () => {
  const { match, w, f } = pond();
  activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  const current = getStatus(f, "current")!;
  assert.equal(current.remainingTicks, 8 * TICK.RATE);
  assert.equal(current.sourceId, "w");

  for (let t = 1; t <= 8 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(hasStatus(f, "current"), false);
});

// --- #84: Waterfall ---------------------------------------------------------------

test("Waterfall damages and applies Current to the selected target", () => {
  const { match, w, f } = pond();
  selectTarget(match, w, "f");
  const r = activateAbility(match, w, WATERFALL, { forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10_000 - 450);
  assert.equal(hasStatus(f, "current"), true);
});

// --- #85: Water attack healing during Current ---------------------------------------

test("Water attacks heal Water based on damage dealt, only while Current is active", () => {
  const { match, w, f } = pond();
  w.castle.hp = 5000;

  // No Current yet → Water Ball does not heal.
  activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(w.castle.hp, 5000);

  // Waterfall applies Current after its damage, so the *next* attack heals.
  activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(w.castle.hp, 5000);

  for (let t = 1; t <= WATER_BALL.cooldownTicks; t++) tickMatch(match, t);
  const hpBefore = w.castle.hp;
  activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  // 250 dealt × 0.25 = 62.5 → 63.
  assert.equal(w.castle.hp, hpBefore + 63);
});

test("healing counts shield-absorbed damage and never exceeds max HP", () => {
  const { match, w, f } = pond();
  applyStatus(f, CURRENT_STATUS, { sourceId: "w", durationTicks: 1000 });
  f.castle.shield = 10_000; // everything absorbed
  w.castle.hp = w.castle.maxHp - 10; // nearly full

  activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(w.castle.hp, w.castle.maxHp); // 63 heal capped at +10
});

// --- #86/#87: Flood damage and duration ---------------------------------------------

test("Flood deals heavy damage and bans targeting Water for 5 seconds", () => {
  const { match, w, f } = pond();
  const r = activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10_000 - 800);
  assert.equal(getStatus(f, "flooded")!.remainingTicks, 5 * TICK.RATE);
});

test("Flood lasts twice as long against a Current-affected target", () => {
  const { match, w, f } = pond();
  activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(hasStatus(f, "current"), true);

  for (let t = 1; t <= WATERFALL.cooldownTicks; t++) tickMatch(match, t);
  // Current (8 s) has expired by now (10 s passed) — reapply it fresh.
  activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(getStatus(f, "flooded")!.remainingTicks, 10 * TICK.RATE);
});

// --- #88: the Flood targeting restriction --------------------------------------------

test("a flooded kingdom cannot target Water but can target anyone else", () => {
  const { match, w, f, n } = pond();
  match.tick = 1000; // clear of all switch cooldowns
  activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });

  assert.equal(selectTarget(match, f, "w").error, "INVALID_TARGET");
  assert.deepEqual(selectTarget(match, f, "n"), { ok: true }); // others fine

  // Ability casts with an explicit target are equally bound.
  const cast = activateAbility(match, f, WATER_BALL, { targetId: "w", forceCrit: false });
  assert.equal(cast.error, "INVALID_TARGET");
  // …but attacking the bystander works.
  const other = activateAbility(match, f, { ...WATER_BALL, id: "fball2" }, { targetId: "n", forceCrit: false });
  assert.equal(other.ok, true);
});

test("Flood severs an existing lock-on onto Water and waives the switch cooldown", () => {
  const { match, w, f, n } = pond();
  match.tick = 10;
  selectTarget(match, f, "w"); // f is aiming at Water, switch cooldown armed

  match.tick = 20; // still inside f's switch cooldown
  activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(f.target, null); // forced off Water
  assert.deepEqual(selectTarget(match, f, "n"), { ok: true }); // immediate re-aim
});

test("the ban lifts when Flood expires", () => {
  const { match, w, f } = pond();
  activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  for (let t = 1; t <= 5 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(hasStatus(f, "flooded"), false);
  assert.deepEqual(selectTarget(match, f, "w"), { ok: true });
});

// --- #89: Fluid Assimilation ---------------------------------------------------------

test("Fluid Assimilation restores exactly 15% of max HP", () => {
  const { match, w } = pond();
  w.castle.hp = 5000;
  const r = activateAbility(match, w, FLUID_ASSIMILATION);
  assert.equal(r.ok, true);
  assert.equal(w.castle.hp, 5000 + 1500); // 15% of 10,000
});

test("Fluid Assimilation never heals above max HP", () => {
  const { match, w } = pond();
  w.castle.hp = 9500;
  activateAbility(match, w, FLUID_ASSIMILATION);
  assert.equal(w.castle.hp, 10_000); // capped, not 11,000
});

// --- #90: Riptide ----------------------------------------------------------------------

test("Riptide restores 50% max HP and grows citizens by 20%, refreshing income", () => {
  const { match, w } = pond();
  w.castle.hp = 2000;
  const r = activateAbility(match, w, RIPTIDE);
  assert.equal(r.ok, true);
  assert.equal(w.castle.hp, 2000 + 5000); // 50% of 10,000
  assert.equal(w.economy.citizens, 12); // 10 × 1.2
  // Income refreshed at once: 12 × $0.03 = $0.36.
  assert.equal(w.economy.incomePerTick, 0.36);
});

test("Riptide healing is capped at max HP", () => {
  const { match, w } = pond();
  w.castle.hp = 8000;
  activateAbility(match, w, RIPTIDE);
  assert.equal(w.castle.hp, 10_000);
});

// --- #100: Water Ability Upgrades ---------------------------------------------------

test("Water Ball upgrades (Lv 1 -> 4) modify damage and cooldown values", () => {
  const { match, w, f } = pond();
  
  // Lv 2: Increased damage (250 -> 300)
  purchaseUpgrade(match, w, WATER_BALL);
  w.castle.hp = 10000;
  f.castle.hp = 10000;
  let r = activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10000 - 300);

  // Lv 3: Reduce cooldown by 10% (60 -> 54 ticks)
  purchaseUpgrade(match, w, WATER_BALL);
  w.castle.hp = 10000;
  f.castle.hp = 10000;
  w.cooldowns = {};
  r = activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(getCooldown(w, "waterBall"), 54);

  // Lv 4: Increased damage (300 -> 350)
  purchaseUpgrade(match, w, WATER_BALL);
  w.castle.hp = 10000;
  f.castle.hp = 10000;
  w.cooldowns = {};
  r = activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10000 - 350);
});

test("Waterfall upgrades (Lv 1 -> 5) increase damage, status duration, reduce cooldown, and boost healing", () => {
  const { match, w, f } = pond();
  
  // Lv 2: Increased damage (450 -> 550)
  purchaseUpgrade(match, w, WATERFALL);
  let r = activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10000 - 550);

  // Lv 3: Duration +2 s (8 s -> 10 s)
  purchaseUpgrade(match, w, WATERFALL);
  w.castle.hp = 10000;
  f.castle.hp = 10000;
  w.cooldowns = {};
  r = activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(getStatus(f, "current")!.remainingTicks, 10 * TICK.RATE);

  // Lv 4: Cooldown -10% (10 s -> 9 s)
  purchaseUpgrade(match, w, WATERFALL);
  w.cooldowns = {};
  r = activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(getCooldown(w, "waterfall"), 9 * TICK.RATE);

  // Lv 5: Increase healing received from attacking Current targets (25% -> 40% lifesteal ratio)
  purchaseUpgrade(match, w, WATERFALL);
  w.cooldowns = {};
  f.castle.hp = 10000;
  applyStatus(f, CURRENT_STATUS, { sourceId: "w", durationTicks: 1000 });
  w.castle.hp = 8000;
  r = activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(w.castle.hp, 8000 + 220); // 550 damage * 0.40 lifesteal
});

test("Flood upgrades (Lv 1 -> 5) boost damage, lockout, cooldown, and increase healing", () => {
  const { match, w, f } = pond();
  
  // Lv 2: Increased damage (800 -> 950)
  purchaseUpgrade(match, w, FLOOD);
  let r = activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10000 - 950);

  // Lv 3: Lockout duration +2 s (5 s -> 7 s)
  purchaseUpgrade(match, w, FLOOD);
  w.cooldowns = {};
  r = activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(getStatus(f, "flooded")!.remainingTicks, 7 * TICK.RATE);

  // Lv 4: Cooldown -10% (20 s -> 18 s)
  purchaseUpgrade(match, w, FLOOD);
  w.cooldowns = {};
  r = activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(getCooldown(w, "flood"), 18 * TICK.RATE);

  // Lv 5: Increased healing from Flood — lifesteal 25% -> 40%
  purchaseUpgrade(match, w, FLOOD);
  w.cooldowns = {};
  f.castle.hp = 10000;
  applyStatus(f, CURRENT_STATUS, { sourceId: "w", durationTicks: 100 });
  w.castle.hp = 8000;
  r = activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(w.castle.hp, 8000 + 380); // 950 damage * 0.40 lifesteal
});

test("Fluid Assimilation upgrades (Lv 1 -> 3) increase healing and reduce cooldown", () => {
  const { match, w } = pond();
  
  // Lv 2: Heal 15% -> 25% HP
  purchaseUpgrade(match, w, FLUID_ASSIMILATION);
  w.castle.hp = 5000;
  let r = activateAbility(match, w, FLUID_ASSIMILATION);
  assert.equal(r.ok, true);
  assert.equal(w.castle.hp, 5000 + 2500); // 25% of 10,000

  // Lv 3: Reduce cooldown by 15% (15 s -> 12.75 s = 255 ticks)
  purchaseUpgrade(match, w, FLUID_ASSIMILATION);
  w.cooldowns = {};
  r = activateAbility(match, w, FLUID_ASSIMILATION);
  assert.equal(r.ok, true);
  assert.equal(getCooldown(w, "fluidAssimilation"), 255);
});

test("Riptide upgrades (Lv 1 -> 3) increase healing, citizen gain, and reduce cooldown", () => {
  const { match, w } = pond();
  
  // Lv 2: Heal 50% -> 70% HP, citizen gain 20% -> 30%
  purchaseUpgrade(match, w, RIPTIDE);
  w.castle.hp = 2000;
  w.economy.citizens = 10;
  let r = activateAbility(match, w, RIPTIDE);
  assert.equal(r.ok, true);
  assert.equal(w.castle.hp, 2000 + 7000); // 70%
  assert.equal(w.economy.citizens, 13); // +30%

  // Lv 3: Reduce cooldown by 15% (90 s -> 76.5 s = 1530 ticks)
  purchaseUpgrade(match, w, RIPTIDE);
  w.cooldowns = {};
  r = activateAbility(match, w, RIPTIDE);
  assert.equal(r.ok, true);
  assert.equal(getCooldown(w, "riptide"), 1530);
});
