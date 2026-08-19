import test from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig, castleHpMultiplier } from "../src/match/matchConfig.js";
import { CASTLE } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";

/**
 * Crowded boards start with more health.
 *
 * At six or seven seats a castle takes fire from every other player at once, so
 * the starting HP that makes a duel a fight makes a full lobby a race to focus
 * one player down first.
 */

function seat(i: number, spectator = false): MatchPlayer {
  return {
    id: `p${i}`,
    socketId: `s${i}`,
    name: `P${i}`,
    kingdomId: KINGDOM_IDS[i]!,
    perks: [],
    ready: true,
    connected: true,
    ...(spectator ? { spectator: true, kingdomId: null } : {}),
  };
}

function configFor(playing: number, spectators = 0) {
  const match = new Match(`R${playing}${spectators}`);
  for (let i = 0; i < playing; i++) match.addPlayer(seat(i));
  for (let i = 0; i < spectators; i++) match.addPlayer(seat(playing + i, true));
  return createMatchConfig(match);
}

test("the multiplier only applies from six seats up", () => {
  for (const n of [1, 2, 3, 4, 5]) assert.equal(castleHpMultiplier(n), 1, `${n} seats`);
  for (const n of [6, 7]) assert.equal(castleHpMultiplier(n), 1.5, `${n} seats`);
});

test("small games are untouched", () => {
  for (const n of [2, 3, 4, 5]) {
    assert.equal(
      configFor(n).startingCastleHp,
      CASTLE.STARTING_HP,
      `${n} players should keep the normal starting health`,
    );
  }
});

test("six and seven player games start at 1.5x health", () => {
  for (const n of [6, 7]) {
    assert.equal(
      configFor(n).startingCastleHp,
      Math.round(CASTLE.STARTING_HP * 1.5),
      `${n} players should start at 1.5x`,
    );
  }
});

test("spectators do not inflate anyone's health", () => {
  // A five-player game with a watcher is still a five-player game. Counting the
  // watcher would hand everyone 50% more health for a board that has not got
  // any more attackers on it.
  assert.equal(configFor(5, 1).startingCastleHp, CASTLE.STARTING_HP);
  assert.equal(configFor(5, 2).startingCastleHp, CASTLE.STARTING_HP);
  // ...and a genuinely crowded board still scales with a watcher present.
  assert.equal(configFor(6, 1).startingCastleHp, Math.round(CASTLE.STARTING_HP * 1.5));
});

test("the snapshot is what the match plays under, so it cannot drift", () => {
  // The config is captured at start; the balance constant is untouched, which is
  // what keeps this out of the balance search and the AI training environment.
  const crowded = configFor(7);
  assert.notEqual(crowded.startingCastleHp, CASTLE.STARTING_HP);
  assert.equal(CASTLE.STARTING_HP, configFor(2).startingCastleHp);
});
