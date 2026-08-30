import { test } from "node:test";
import assert from "node:assert/strict";
import { abilityPrices } from "../src/net/gameSync.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { WATER_ABILITIES, WATER_BALL } from "../src/data/waterAbilities.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

// The state:sync payload's per-player `abilityPrices`: the SINGLE source of
// every price the HUD shows (cast, unlock, next upgrade, per-charge), resolved
// from the kingdom's ability data with upgrade tiers and perks applied. The
// client holds no cost data of its own, so these must be complete and exact.

const player = (
  id: string,
  kingdomId: string,
  perks: MatchPlayer["perks"] = [],
): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  perks,
  ready: true,
  connected: true,
});

function waterPlayer(perks: MatchPlayer["perks"] = []): PlayerState {
  const match = new Match("1234");
  match.addPlayer(player("w", "water", perks));
  match.addPlayer(player("f", "plains"));
  match.hostId = "w";
  match.start(createMatchConfig(match));
  return match.gameState!.getPlayer("w")!;
}

test("every ability of the kingdom is priced, locked or not", () => {
  const w = waterPlayer();
  const prices = abilityPrices(w);
  assert.deepEqual(
    Object.keys(prices).sort(),
    WATER_ABILITIES.map((a) => a.id).sort(),
  );
});

test("a locked ability reports its unlock price and no upgrade price", () => {
  const w = waterPlayer();
  const p = abilityPrices(w)["waterBall"]!;
  assert.equal(p.cast, WATER_BALL.cost);
  // No explicit unlockCost, so the rule is 50% of the cast cost, rounded up.
  assert.equal(p.unlock, Math.ceil(WATER_BALL.cost * 0.5));
  assert.equal(p.upgrade, null); // can't upgrade what you don't own
});

test("an unlocked ability reports its next upgrade tier and no unlock price", () => {
  const w = waterPlayer();
  w.unlocked["waterBall"] = true;
  const p = abilityPrices(w)["waterBall"]!;
  assert.equal(p.unlock, null);
  assert.equal(p.upgrade, 150); // Water Ball's tier 1
});

test("cooldown tiers' costMultiplier discounts show in the reported cast price", () => {
  const w = waterPlayer();
  w.unlocked["waterBall"] = true;
  // Tier 2 is Water Ball's cooldown tier: costMultiplier 0.85.
  w.upgrades["waterBall"] = 2;
  assert.equal(
    abilityPrices(w)["waterBall"]!.cast,
    Math.floor(WATER_BALL.cost * 0.85),
  );
});

test("a fully upgraded ability reports no further upgrade price", () => {
  const w = waterPlayer();
  w.unlocked["waterBall"] = true;
  w.upgrades["waterBall"] = 3; // Water Ball's last tier
  assert.equal(abilityPrices(w)["waterBall"]!.upgrade, null);
});

test("the Great Merchants perk discounts the reported unlock price", () => {
  const w = waterPlayer(["greatMerchants", "extraGuards"]);
  // The perk takes 15% off whatever the unlock price would otherwise be.
  const listedUnlock = Math.ceil(WATER_BALL.cost * 0.5);
  assert.equal(
    abilityPrices(w)["waterBall"]!.unlock,
    Math.ceil(listedUnlock * 0.25),
  );
});

test("charge-based abilities report their charge economy", () => {
  const match = new Match("1234");
  match.addPlayer(player("e", "electricity"));
  match.addPlayer(player("f", "plains"));
  match.hostId = "e";
  match.start(createMatchConfig(match));
  const e = match.gameState!.getPlayer("e")!;

  const barrage = abilityPrices(e)["lightningBarrage"]!;
  assert.equal(barrage.unlock, 100); // its explicit unlockCost
  assert.deepEqual(barrage.charges, {
    max: 3,
    costPerCharge: 80,
    damageByCharges: [230, 475, 800],
    rechargeTicks: 60,
  });

  // Tier 2 speeds the regen up (3 s -> 2.5 s) — the reported table follows.
  e.upgrades["lightningBarrage"] = 2;
  assert.equal(abilityPrices(e)["lightningBarrage"]!.charges!.rechargeTicks, 50);
});

test("abilities without a charge system report none", () => {
  assert.equal(abilityPrices(waterPlayer())["waterBall"]!.charges, undefined);
});
