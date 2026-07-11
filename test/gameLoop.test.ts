import { test } from "node:test";
import assert from "node:assert/strict";
import { GameLoop } from "../src/engine/GameLoop.js";
import { GameLoopManager } from "../src/engine/GameLoopManager.js";
import { MatchManager } from "../src/match/MatchManager.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";

const player = (id: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: "plains",
  ready: true,
  connected: true,
});

test("advance runs one tick per elapsed interval", () => {
  const ticks: number[] = [];
  const loop = new GameLoop({ tickRate: 20, onTick: (t) => ticks.push(t) }); // 50ms
  loop.advance(0); // prime
  loop.advance(50);
  loop.advance(100);
  assert.deepEqual(ticks, [1, 2]);
  assert.equal(loop.currentTick, 2);
});

test("advance catches up multiple ticks after a gap", () => {
  const ticks: number[] = [];
  const loop = new GameLoop({ tickRate: 20, onTick: (t) => ticks.push(t) });
  loop.advance(0);
  loop.advance(160); // 3 whole ticks (accumulator 10ms left)
  assert.deepEqual(ticks, [1, 2, 3]);
});

test("catch-up is capped to avoid a spiral", () => {
  let count = 0;
  const loop = new GameLoop({
    tickRate: 20,
    onTick: () => count++,
    maxCatchUpTicks: 5,
  });
  loop.advance(0);
  loop.advance(100_000); // enormous gap
  assert.equal(count, 5);
});

test("start and stop toggle the running flag", () => {
  const loop = new GameLoop({ tickRate: 20, onTick: () => {} });
  assert.equal(loop.running, false);
  loop.start();
  assert.equal(loop.running, true);
  loop.stop();
  assert.equal(loop.running, false);
});

test("GameLoopManager starts and stops a loop per active match", () => {
  const matches = new MatchManager();
  const gameLoops = new GameLoopManager(matches);
  const match = matches.createMatch();
  match.addPlayer(player("a"));
  match.addPlayer(player("b"));
  match.hostId = "a";
  match.start(createMatchConfig(match));

  gameLoops.start(match);
  assert.equal(gameLoops.activeCount, 1);
  gameLoops.start(match); // idempotent
  assert.equal(gameLoops.activeCount, 1);

  gameLoops.stop(match.roomCode);
  assert.equal(gameLoops.activeCount, 0);
});
