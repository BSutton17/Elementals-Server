import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPassiveIncome } from "../src/engine/economy.js";
import { createGameState } from "../src/match/GameState.js";
import type { MatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";

const config: MatchConfig = {
  roomCode: "1234",
  maxPlayers: 8,
  tickRate: 20,
  startingCitizens: 10,
  startingCastleHp: 10_000,
};

const player = (id: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: "plains",
  ready: true,
  connected: true,
});

test("awards $0.55 per citizen per second (0.0275 per tick at 20 ticks/sec)", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  assert.equal(a.economy.citizens, 10);

  applyPassiveIncome(state);
  assert.equal(a.economy.incomePerTick, 0.275); // 10 * 0.0275
  assert.equal(a.economy.currency, 0.275);

  applyPassiveIncome(state);
  applyPassiveIncome(state);
  assert.equal(a.economy.currency, 0.825); // three ticks: 0.275 * 3
});

test("income scales with citizen count and stays precise", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  a.economy.citizens = 7; // 7 * 0.0275 = 0.1925 per tick, exact at 4 decimals

  for (let i = 0; i < 3; i++) applyPassiveIncome(state);
  assert.equal(a.economy.currency, 0.5775); // 0.1925 * 3
});

test("eliminated players earn nothing", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  a.eliminated = true;

  applyPassiveIncome(state);
  assert.equal(a.economy.currency, 0);
});
