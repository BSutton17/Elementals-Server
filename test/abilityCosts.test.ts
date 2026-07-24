import { test } from "node:test";
import assert from "node:assert/strict";
import { abilityCosts } from "../src/net/gameSync.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

// The state:sync payload's per-player `abilityCosts`: effective cast prices
// with upgrade-tier discounts applied, so the HUD's price tags always match
// what a cast will actually charge.

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

function waterPlayer(): PlayerState {
  const match = new Match("1234");
  match.addPlayer(player("w", "water"));
  match.addPlayer(player("f", "plains"));
  match.hostId = "w";
  match.start(createMatchConfig(match));
  return match.gameState!.getPlayer("w")!;
}

test("abilityCosts is empty while nothing is unlocked", () => {
  const w = waterPlayer();
  assert.deepEqual(abilityCosts(w), {});
});

test("unlocked abilities report their base cast cost", () => {
  const w = waterPlayer();
  w.unlocked["waterBall"] = true;
  assert.deepEqual(abilityCosts(w), { waterBall: 100 });
});

test("cooldown tiers' costMultiplier discounts show in the reported price", () => {
  const w = waterPlayer();
  w.unlocked["waterBall"] = true;
  // Tier 2 is Water Ball's cooldown tier: costMultiplier 0.85 → floor(100 × 0.85).
  w.upgrades["waterBall"] = 2;
  assert.deepEqual(abilityCosts(w), { waterBall: 85 });
});

test("unknown ability ids are skipped rather than crashing the sync", () => {
  const w = waterPlayer();
  w.unlocked["waterBall"] = true;
  w.unlocked["notARealAbility"] = true;
  assert.deepEqual(abilityCosts(w), { waterBall: 100 });
});
