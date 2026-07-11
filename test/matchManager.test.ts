import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchManager } from "../src/match/MatchManager.js";
import { LOBBY } from "../src/data/balance.js";

const CODE_PATTERN = new RegExp(`^\\d{${LOBBY.ROOM_CODE_LENGTH}}$`);

test("creates matches with unique, well-formed room codes", () => {
  const manager = new MatchManager();
  const codes = new Set<string>();

  for (let i = 0; i < 100; i++) {
    const match = manager.createMatch();
    assert.match(match.roomCode, CODE_PATTERN);
    assert.ok(!codes.has(match.roomCode), "room codes must be unique");
    codes.add(match.roomCode);
  }
  assert.equal(manager.matchCount, 100);
});

test("looks up and removes matches by room code", () => {
  const manager = new MatchManager();
  const match = manager.createMatch();

  assert.ok(manager.hasMatch(match.roomCode));
  assert.equal(manager.getMatch(match.roomCode), match);

  assert.equal(manager.removeMatch(match.roomCode), true);
  assert.equal(manager.removeMatch(match.roomCode), false);
  assert.equal(manager.hasMatch(match.roomCode), false);
  assert.equal(manager.getMatch(match.roomCode), undefined);
});
