import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buyCitizen,
  buyShield,
  citizenCost,
  repairCastle,
  repairCost,
} from "../src/engine/purchases.js";
import { earn } from "../src/engine/money.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { CASTLE, ECONOMY, SHIELD } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

const player = (id: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: "plains",
  ready: true,
  connected: true,
});

function activeMatch(): { match: Match; a: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(player("a"));
  match.addPlayer(player("b"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  return { match, a: match.gameState!.getPlayer("a")! };
}

test("buying a citizen spends money and adds a citizen", () => {
  const { match, a } = activeMatch();
  earn(a, 25);
  const startCitizens = a.economy.citizens;

  const result = buyCitizen(match, a);
  assert.equal(result.ok, true);
  assert.equal(a.economy.citizens, startCitizens + 1);
  assert.equal(a.economy.currency, 25 - ECONOMY.CITIZEN_COST);
});

test("citizen cost scales up after each purchase", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);

  const cost0 = citizenCost(a); // base
  assert.equal(cost0, ECONOMY.CITIZEN_COST);

  assert.equal(buyCitizen(match, a).ok, true);
  const cost1 = citizenCost(a);
  assert.ok(cost1 > cost0, `cost should rise: ${cost0} → ${cost1}`);

  assert.equal(buyCitizen(match, a).ok, true);
  const cost2 = citizenCost(a);
  assert.ok(cost2 > cost1, `cost should keep rising: ${cost1} → ${cost2}`);

  // Purchase counter tracks the escalation.
  assert.equal(a.economy.citizensPurchased, 2);
});

test("buying a citizen fails without enough money and changes nothing", () => {
  const { match, a } = activeMatch();
  earn(a, ECONOMY.CITIZEN_COST - 1);
  const startCitizens = a.economy.citizens;

  const result = buyCitizen(match, a);
  assert.equal(result.ok, false);
  assert.equal(result.error, "INSUFFICIENT_FUNDS");
  assert.equal(a.economy.citizens, startCitizens); // unchanged
});

test("repairing the castle restores HP for money, capped at max", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - 2000; // 2000 missing
  earn(a, 2000);

  const result = repairCastle(match, a);
  assert.equal(result.ok, true);
  // Repairs REPAIR_AMOUNT (1000) HP for the flat base cost ($500).
  assert.equal(a.castle.hp, a.castle.maxHp - 1000);
  assert.equal(a.economy.currency, 2000 - CASTLE.REPAIR_COST);
});

test("repair never exceeds max HP; the flat cost applies regardless", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - 100; // only 100 missing
  earn(a, 2000);

  assert.equal(repairCastle(match, a).ok, true);
  assert.equal(a.castle.hp, a.castle.maxHp); // clamped to full
  assert.equal(a.economy.currency, 2000 - CASTLE.REPAIR_COST);
});

test("repairs are capped at MAX_REPAIRS per match; ability healing is not", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - 5000;
  earn(a, 100_000);

  // Spend all 3 repairs: 500, 625, 781.
  const costs: number[] = [];
  for (let i = 0; i < CASTLE.MAX_REPAIRS; i++) {
    costs.push(repairCost(a));
    assert.equal(repairCastle(match, a).ok, true);
  }
  assert.deepEqual(costs, [500, 625, 781]);
  assert.equal(a.castle.repairs, 3);

  // The 4th is refused outright, and the quoted price drops to 0.
  const refused = repairCastle(match, a);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "REPAIR_LIMIT");
  assert.equal(repairCost(a), 0);
});

test("repair cost scales up after each repair", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - 5000; // plenty of room for several repairs
  earn(a, 10_000);

  const cost0 = repairCost(a);
  assert.equal(repairCastle(match, a).ok, true);
  const cost1 = repairCost(a);
  assert.ok(cost1 > cost0, `repair cost should rise: ${cost0} → ${cost1}`);

  assert.equal(repairCastle(match, a).ok, true);
  const cost2 = repairCost(a);
  assert.ok(cost2 > cost1, `repair cost should keep rising: ${cost1} → ${cost2}`);

  assert.equal(a.castle.repairs, 2);
});

test("buying a shield grants the standard shield HP for money", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  assert.equal(a.castle.shield, 0);

  const result = buyShield(match, a);
  assert.equal(result.ok, true);
  assert.equal(a.castle.shield, SHIELD.STANDARD_HP);
  assert.equal(a.economy.currency, 1000 - SHIELD.COST);
});

test("buying a shield fails without enough money", () => {
  const { match, a } = activeMatch();
  earn(a, SHIELD.COST - 1);
  const result = buyShield(match, a);
  assert.equal(result.ok, false);
  assert.equal(result.error, "INSUFFICIENT_FUNDS");
  assert.equal(a.castle.shield, 0);
});

test("cannot buy a second shield while one is active", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);

  assert.equal(buyShield(match, a).ok, true); // first one
  const second = buyShield(match, a);
  assert.equal(second.ok, false);
  assert.equal(second.error, "SHIELD_ACTIVE");
  assert.equal(a.castle.shield, SHIELD.STANDARD_HP); // still just one
  // Once depleted, another can be bought.
  a.castle.shield = 0;
  assert.equal(buyShield(match, a).ok, true);
});

test("repairing a full castle is rejected", () => {
  const { match, a } = activeMatch();
  earn(a, 100);
  const result = repairCastle(match, a); // castle starts at full
  assert.equal(result.ok, false);
  assert.equal(result.error, "INVALID_TRANSACTION");
});

test("repair fails without enough money", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - 1000;
  earn(a, 1); // far too little
  const result = repairCastle(match, a);
  assert.equal(result.ok, false);
  assert.equal(result.error, "INSUFFICIENT_FUNDS");
  assert.equal(a.castle.hp, a.castle.maxHp - 1000); // unchanged
});
