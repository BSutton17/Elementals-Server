import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { PARTY_GAMES, startParty } from "../src/engine/party/index.js";
import { partyForWire } from "../src/net/partySync.js";
import { PARTY, TICK } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";

// The registry, swept.
//
// ⚠️ THIS IS THE TEST THAT REPLACES CLICKING SIXTEEN BUTTONS. Every other party
// test asks whether one minigame plays correctly; this one asks whether each of
// them starts, runs to its own end and clears without anybody watching — which
// is the failure the debug launcher was built to hunt, and the failure most
// likely to be introduced by adding the seventeenth.
//
// It deliberately knows almost nothing about any individual game. A game that
// needs special handling to survive this file is a game that will need special
// handling on the night, and should be fixed rather than accommodated here.

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
  isBot: false,
});

/**
 * Four seats, and the roll turned off.
 *
 * The shared rng answers 0.5 — above the roll's `living / 10` threshold at any
 * table this size — so ticking a session to its end never starts a second one
 * underneath the assertion.
 */
function table(): Match {
  const match = new Match("1234", { rng: () => 0.5 });
  ["fire", "water", "earth", "air"].forEach((k, i) => match.addPlayer(player(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  for (const p of match.gameState!.getPlayers()) earn(p, 20_000);
  return match;
}

/** Haunted is the one game with a precondition: somebody has to be dead. */
function arrange(match: Match, gameId: string): void {
  if (gameId !== "haunted") return;
  const victim = match.gameState!.getPlayers()[3];
  victim.eliminated = true;
  victim.castle.hp = 0;
}

test("the registry is the sixteen, each named once", () => {
  assert.equal(PARTY_GAMES.length, 16);
  const ids = PARTY_GAMES.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, "two games share an id");
  for (const game of PARTY_GAMES) {
    assert.ok(game.description.length > 0, `${game.id} has no description`);
    assert.ok(game.maxSeconds > 0, `${game.id} never expires`);
  }
});

for (const game of PARTY_GAMES) {
  test(`${game.id} starts, runs out and clears`, () => {
    const match = table();
    arrange(match, game.id);

    const session = startParty(match, game.id);
    assert.ok(session, `${game.id} refused to start`);
    assert.equal(session.gameId, game.id);

    // Everyone still standing has a slot. A missing one is a player who cannot
    // act, cannot finish, and holds the whole table on the expiry clock.
    for (const p of match.gameState!.getPlayers()) {
      if (p.eliminated) continue;
      assert.ok(session.players[p.id], `${game.id} left ${p.id} out of the session`);
    }

    // Nobody touches anything: this is the timeout path, which is the one every
    // player who walks away takes, and the one `forceFinish` exists for.
    const budget =
      Math.round((game.maxSeconds + PARTY.RESULT_SECONDS + 2) * TICK.RATE);
    for (let i = 0; i < budget; i++) tickMatch(match, match.tick + 1);

    assert.equal(
      match.gameState!.party,
      null,
      `${game.id} was still on screen ${game.maxSeconds}s after it began`,
    );
  });

  test(`${game.id} survives the trip to the wire`, () => {
    const match = table();
    arrange(match, game.id);
    const session = startParty(match, game.id)!;

    const wire = partyForWire(match, session);
    assert.equal(wire.gameId, game.id);
    // Structured-cloneable, because Socket.IO has to encode it. A Set, a Map or
    // a function in the session state is invisible to every test that reads the
    // session directly, and fatal the moment it is sent.
    assert.doesNotThrow(
      () => structuredClone(wire),
      `${game.id} put something unserialisable on the wire`,
    );
  });
}
