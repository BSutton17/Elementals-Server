import { test } from "node:test";
import assert from "node:assert/strict";
import { broadcastGameEvents } from "../src/net/gameSync.js";
import { GameLoopManager } from "../src/engine/GameLoopManager.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchManager } from "../src/match/MatchManager.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { GameplayEvent } from "../src/engine/events.js";

// Epic 9 VFX transport: the server forwards its authoritative EventBus to the
// match room as `evt:batch`, and the loop only turns the bus on when a consumer
// is wired.

function stubIo() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const io = {
    to: () => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    }),
  } as unknown as import("socket.io").Server;
  return { io, emitted };
}

const fakeMatch = { roomCode: "R", gameState: { tick: 7 } } as unknown as Match;

const castEvent: GameplayEvent = {
  type: "abilityCast",
  tick: 7,
  casterId: "a",
  abilityId: "fireball",
  targetIds: ["b"],
  cost: 100,
};

test("broadcastGameEvents emits evt:batch carrying the events and tick", () => {
  const { io, emitted } = stubIo();
  broadcastGameEvents(io, fakeMatch, [castEvent]);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.event, "evt:batch");
  const payload = emitted[0]!.payload as { tick: number; events: GameplayEvent[] };
  assert.equal(payload.tick, 7);
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0]!.type, "abilityCast");
});

test("broadcastGameEvents is a no-op for an empty batch", () => {
  const { io, emitted } = stubIo();
  broadcastGameEvents(io, fakeMatch, []);
  assert.equal(emitted.length, 0);
});

function startedMatch(): Match {
  const player = (id: string, kingdomId: string): MatchPlayer => ({
    id,
    socketId: `s-${id}`,
    name: id,
    kingdomId,
    ready: true,
    connected: true,
  });
  const match = new Match("ROOM");
  match.addPlayer(player("a", "fire"));
  match.addPlayer(player("b", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  return match;
}

test("GameLoopManager subscribes to the bus while running, unsubscribes on stop", () => {
  const match = startedMatch();
  const matches = {
    getMatch: (rc: string) => (rc === "ROOM" ? match : undefined),
  } as unknown as MatchManager;
  const mgr = new GameLoopManager(matches, { syncEvents: () => {} });

  assert.equal(match.gameState!.events.enabled, false);
  mgr.start(match);
  assert.equal(match.gameState!.events.enabled, true); // subscribed for VFX
  mgr.stop("ROOM");
  assert.equal(match.gameState!.events.enabled, false); // cleaned up
});

test("GameLoopManager leaves the bus off when no syncEvents consumer is wired", () => {
  const match = startedMatch();
  const matches = { getMatch: () => match } as unknown as MatchManager;
  const mgr = new GameLoopManager(matches, {});
  mgr.start(match);
  assert.equal(match.gameState!.events.enabled, false); // producers pay nothing
  mgr.stop("ROOM");
});
