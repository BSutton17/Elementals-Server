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
import { getStatus, removeStatus, tickStatuses } from "../src/engine/status.js";
import { recalcIncome } from "../src/engine/economy.js";
import {
  ICICLE,
  FLOOD_OF_FROST,
  FREEZE_TO_THE_CORE,
  FROZEN_FOCUS,
  BLIZZARD,
} from "../src/data/iceAbilities.js";

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** Starts a match with one player per kingdom id given, in order (p0, p1, …). */
function tundra(kingdoms: string[]): { match: Match; players: PlayerState[] } {
  const match = new Match("1234");
  kingdoms.forEach((k, i) => match.addPlayer(player(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const players = kingdoms.map((_, i) => gs.getPlayer(`p${i}`)!);
  for (const p of players) earn(p, 100_000);
  return { match, players };
}

/** rng that returns the given values in order (repeating the last). */
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)]!;
};

/** A plain attack with a real cooldown, for cooldown-penalty checks. */
const strike: AbilityDefinition = {
  id: "strike",
  kind: "attack",
  cost: 0,
  cooldownTicks: 100,
  targeting: { mode: "singleEnemy" },
  effects: [{ type: "damage", target: "target", params: { amount: 1000 } }],
};

/** A no-op utility, to prove Frozen only bars attacks. */
const rally: AbilityDefinition = {
  id: "rally",
  kind: "utility",
  cost: 0,
  cooldownTicks: 0,
  targeting: { mode: "self" },
  effects: [{ type: "heal", target: "self", params: { amount: 1 } }],
};

// --- Passives -----------------------------------------------------------------------

test("Cold Embrace: Ice attacks have a 10% chance to Freeze", () => {
  const { match, players } = tundra(["ice", "plains"]);
  const [a, b] = players;

  // Roll fails (0.99 >= 0.10): no freeze.
  activateAbility(match, a, ICICLE, { targetId: "p1", forceCrit: false, rng: () => 0.99 });
  assert.equal(b.castle.hp, b.castle.maxHp - 250);
  assert.ok(!getStatus(b, "frozen"));

  // Roll succeeds (0.05 < 0.10): Frozen for 4 s.
  a.cooldowns = {};
  activateAbility(match, a, ICICLE, { targetId: "p1", forceCrit: false, rng: () => 0.05 });
  const frozen = getStatus(b, "frozen");
  assert.ok(frozen);
  assert.equal(frozen.remainingTicks, 80);
});

test("Frozen kingdoms cannot attack — utilities still work", () => {
  const { match, players } = tundra(["ice", "plains"]);
  const [a, b] = players;

  activateAbility(match, a, FREEZE_TO_THE_CORE, { targetId: "p1", forceCrit: false, rng: () => 0.99 });
  assert.ok(getStatus(b, "frozen"));

  const blocked = activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.99 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "ATTACKS_BLOCKED");

  const utility = activateAbility(match, b, rally);
  assert.equal(utility.ok, true); // only attacks are barred

  // Thawed: attacks work again.
  removeStatus(b, "frozen");
  const after = activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.99 });
  assert.equal(after.ok, true);
});

test("Frostbite: attackers risk having their production slowed by 50%", () => {
  const { match, players } = tundra(["ice", "plains"]);
  const [, b] = players;

  // Roll fails (0.99 >= 0.15): no frostbite.
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.99 });
  assert.ok(!getStatus(b, "frostbite"));

  // Roll succeeds (0.0 < 0.15): production halved while it lasts.
  b.cooldowns = {};
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.0 });
  assert.ok(getStatus(b, "frostbite"));
  recalcIncome(b);
  assert.equal(b.economy.incomePerTick, 0.1375); // 10 citizens x $0.0275 = 0.275, halved
});

// --- Flood of Frost -----------------------------------------------------------------

test("Flood of Frost can apply Chilling Retribution, lengthening the target's cooldowns", () => {
  const { match, players } = tundra(["ice", "plains"]);
  const [a, b] = players;

  // rng sequence: 0.5 fails the Cold Embrace roll, 0.1 passes the 35% chance.
  const r = activateAbility(match, a, FLOOD_OF_FROST, {
    targetId: "p1",
    forceCrit: false,
    rng: seq(0.5, 0.1),
  });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 450);
  const chill = getStatus(b, "chillingRetribution");
  assert.ok(chill);
  assert.equal(chill.remainingTicks, 120); // 6 s

  // Cooldowns b arms while chilled are 30% longer: 100 -> 130.
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.99 });
  assert.equal(b.cooldowns["strike"], 130);
});

// --- Freeze to the Core -------------------------------------------------------------

test("Freeze to the Core Lv5: thawing briefly slows the target's production", () => {
  const { match, players } = tundra(["ice", "plains"]);
  const [a, b] = players;
  a.upgrades["freezeToTheCore"] = 4;

  activateAbility(match, a, FREEZE_TO_THE_CORE, { targetId: "p1", forceCrit: false, rng: () => 0.99 });
  const frozen = getStatus(b, "frozen");
  assert.ok(frozen);
  assert.equal(frozen.remainingTicks, 120); // Lv3: 6 s

  // Let the freeze expire naturally: Frostbite follows for 3 s.
  frozen.remainingTicks = 1;
  tickStatuses(match.gameState!);
  assert.ok(!getStatus(b, "frozen"));
  const thaw = getStatus(b, "frostbite");
  assert.ok(thaw);
  assert.equal(thaw.remainingTicks, 60); // 3 s
  recalcIncome(b);
  assert.equal(b.economy.incomePerTick, 0.1375); // halved
});

// --- Frozen Focus -------------------------------------------------------------------

test("Frozen Focus guarantees the chance procs of the next two Ice attacks", () => {
  const { match, players } = tundra(["ice", "plains"]);
  const [a, b] = players;

  activateAbility(match, a, FROZEN_FOCUS);
  assert.equal(getStatus(a, "frozenFocus")!.stacks, 2);

  // Attack 1: the 10% Cold Embrace roll would fail at 0.99 — guaranteed anyway.
  a.cooldowns = {};
  activateAbility(match, a, ICICLE, { targetId: "p1", forceCrit: false, rng: () => 0.99 });
  assert.ok(getStatus(b, "frozen"));
  assert.equal(getStatus(a, "frozenFocus")!.stacks, 1);

  // Attack 2: Flood of Frost's 35% retribution is guaranteed too; focus spent.
  removeStatus(b, "frozen");
  a.cooldowns = {};
  activateAbility(match, a, FLOOD_OF_FROST, { targetId: "p1", forceCrit: false, rng: () => 0.99 });
  assert.ok(getStatus(b, "chillingRetribution"));
  assert.ok(!getStatus(a, "frozenFocus"));

  // Attack 3: back to honest rolls — 0.99 procs nothing.
  removeStatus(b, "frozen");
  a.cooldowns = {};
  activateAbility(match, a, ICICLE, { targetId: "p1", forceCrit: false, rng: () => 0.99 });
  assert.ok(!getStatus(b, "frozen"));
});

// --- Blizzard -----------------------------------------------------------------------

test("Blizzard stops every opposing kingdom from attacking and freezes their production", () => {
  const { match, players } = tundra(["ice", "plains", "water"]);
  const [a, b, c] = players;

  const r = activateAbility(match, a, BLIZZARD);
  assert.equal(r.ok, true);
  for (const p of [b, c]) {
    const status = getStatus(p, "blizzard");
    assert.ok(status);
    assert.equal(status.remainingTicks, 140); // 7 s
    const blocked = activateAbility(match, p, strike, { targetId: "p0", forceCrit: false, rng: () => 0.99 });
    assert.equal(blocked.error, "ATTACKS_BLOCKED");
    recalcIncome(p);
    assert.equal(p.economy.incomePerTick, 0); // production frozen
  }
  assert.ok(!getStatus(a, "blizzard")); // never the caster
});

// --- Ice Ability Upgrades -------------------------------------------------------------

test("Ice upgrade tiers resolve their overrides", () => {
  // Icicle: standard damage/cooldown path.
  const ic = resolveAbility(ICICLE, 3);
  assert.equal(ic.effects[0].params.amount, 350);
  assert.equal(ic.cooldownTicks, 54);

  // Flood of Frost: Lv2 damage, Lv3 retribution duration, Lv4 CD, Lv5 penalty.
  const ff = resolveAbility(FLOOD_OF_FROST, 4);
  assert.equal(ff.effects[0].params.amount, 550);
  assert.equal(ff.effects[1].chance, 0.35); // chance itself unchanged
  assert.equal(ff.effects[1].params.durationTicks, 180); // 9 s
  assert.equal(ff.cooldownTicks, 180); // 9 s
  assert.equal(ff.effects[1].params.status?.modifiers?.[0].value, 1.45);

  // Freeze to the Core: Lv2 damage, Lv3 freeze duration, Lv4 CD, Lv5 thaw slow.
  const fc = resolveAbility(FREEZE_TO_THE_CORE, 4);
  assert.equal(fc.effects[0].params.amount, 400);
  assert.equal(fc.effects[1].params.durationTicks, 120); // 6 s
  assert.equal(fc.cooldownTicks, 360); // 18 s
  assert.ok(fc.effects[1].params.status?.onExpireStatus);

  // Frozen Focus: Lv2 window duration, Lv3 CD.
  const fo = resolveAbility(FROZEN_FOCUS, 2);
  assert.equal(fo.effects[0].params.durationTicks, 900); // 45 s
  assert.equal(fo.cooldownTicks, 425);

  // Blizzard: Lv2 duration, Lv3 CD.
  const bz = resolveAbility(BLIZZARD, 2);
  assert.equal(bz.effects[0].params.durationTicks, 180); // 9 s
  assert.equal(bz.cooldownTicks, 1530);
});
