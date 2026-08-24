import test from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { MatchManager } from "../src/match/MatchManager.js";
import { removePlayerFromMatch } from "../src/net/lobbyRoom.js";
import type { MatchPlayer } from "../src/match/types.js";

/**
 * Disconnecting out of an active match still produces a victory screen.
 *
 * ⚠️ IT DID NOT, AND THE TWO HALVES NEVER MET. `removePlayer` deletes from the
 * LOBBY roster, while `resolveWinner` counts un-eliminated players in the GAME
 * STATE — which the removal never touched. A player who dropped stayed alive in
 * the game forever, so in a duel the survivor count never fell to one, the
 * match never ended, and the remaining player sat there with no result.
 */

function seat(id: string, kingdomId: string): MatchPlayer {
  return { id, socketId: null, name: id, kingdomId, ready: true, connected: true } as never;
}

/** Records what the room was told, so the emit can be asserted on. */
function fakeIo() {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  return {
    emitted,
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emitted.push({ room, event, payload });
        },
      };
    },
  };
}

function activeMatch(kingdoms: string[]): { match: Match; matches: MatchManager } {
  const match = new Match("ROOM1");
  kingdoms.forEach((k, i) => match.addPlayer(seat(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  const matches = new MatchManager();
  (matches as unknown as { matches: Map<string, Match> }).matches.set("ROOM1", match);
  return { match, matches };
}

test("the last player standing wins when everyone else disconnects", () => {
  const { match, matches } = activeMatch(["fire", "water"]);
  const io = fakeIo();

  removePlayerFromMatch(io as never, matches, "ROOM1", "p1", "disconnected");

  assert.equal(match.phase, "ended", "the match should be over");
  assert.equal(match.winnerId, "p0", "the survivor should have won");
  const ended = io.emitted.find((e) => e.event === "match:ended");
  assert.ok(ended, "the room was never told the match ended — no victory screen");
  assert.deepEqual(ended!.payload, { winnerId: "p0" });
});

test("a disconnect that leaves several players alive does not end the match", () => {
  const { match, matches } = activeMatch(["fire", "water", "air"]);
  const io = fakeIo();

  removePlayerFromMatch(io as never, matches, "ROOM1", "p2", "disconnected");

  assert.equal(match.phase, "active", "two kingdoms are still standing");
  assert.equal(match.winnerId, null);
  assert.equal(io.emitted.some((e) => e.event === "match:ended"), false);
});

test("leaving an active match eliminates the seat rather than just unlisting it", () => {
  // The elimination is what the win condition can actually see, and it also
  // frees anyone aiming at the departed kingdom.
  const { match, matches } = activeMatch(["fire", "water", "air"]);
  const state = match.gameState!;
  state.getPlayer("p0")!.target = "p2";

  removePlayerFromMatch(fakeIo() as never, matches, "ROOM1", "p2", "disconnected");

  assert.equal(state.getPlayer("p2")!.eliminated, true);
  assert.equal(state.getPlayer("p0")!.target, null, "the aimer should have been freed");
});

test("removing a player from a lobby that never started is untouched", () => {
  const match = new Match("ROOM2");
  match.addPlayer(seat("p0", "fire"));
  match.addPlayer(seat("p1", "water"));
  match.hostId = "p0";
  const matches = new MatchManager();
  (matches as unknown as { matches: Map<string, Match> }).matches.set("ROOM2", match);
  const io = fakeIo();

  removePlayerFromMatch(io as never, matches, "ROOM2", "p1", "left");

  assert.equal(match.phase, "lobby");
  assert.equal(match.winnerId, null);
  assert.equal(io.emitted.some((e) => e.event === "match:ended"), false);
});
