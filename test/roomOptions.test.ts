import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { tickMonsterSpawn } from "../src/engine/monster.js";
import { MONSTER, TICK } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";

// The room's optional rules, at the level where they actually take effect.
//
// The socket layer that guards them is covered in lobby.test.ts; this is the
// behaviour behind the switch — what a room defaults to, and what "monsters
// off" does to a match that would otherwise have had one.

const matchPlayer = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
});

function table(visibility: "public" | "private"): Match {
  // rng 0 passes every chance check, so a monster spawns at the first
  // opportunity unless something stops it.
  const match = new Match("1234", { rng: () => 0, visibility });
  ["fire", "water", "earth"].forEach((k, i) =>
    match.addPlayer(matchPlayer(`p${i}`, k)),
  );
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  return match;
}

const FIRST_ROLL_TICKS = MONSTER.FIRST_ROLL_SECONDS * TICK.RATE;

test("neither optional mode runs until somebody asks for it", () => {
  // ⚠️ THE SAME DEFAULT, AND PARTY MODE DID NOT ALWAYS SHARE IT. It ran in
  // every private room on the reasoning that a room of friends is the audience
  // it was built for — but it stops production, holds attacks and takes the
  // middle of the field, so a table that sat down to play the game got a maze
  // instead without anyone having chosen it. Both are now switches in the room
  // options panel, and both start off.
  for (const visibility of ["private", "public"] as const) {
    const match = table(visibility);
    assert.equal(match.monstersEnabled, false, `monsters were on in a ${visibility} room`);
    assert.equal(match.partyModeEnabled, false, `party mode was on in a ${visibility} room`);
  }
});

test("with monsters off, nothing ever arrives", () => {
  const match = table("public");
  for (let i = 0; i < FIRST_ROLL_TICKS * 4; i++) tickMatch(match, match.tick + 1);
  assert.equal(match.gameState!.monster, null, "a monster spawned anyway");
});

test("switching them off leaves no spawn clock behind", () => {
  // Checked before the clock is armed rather than at the roll, so a room with
  // monsters off carries no spawn state at all — there is nothing to reset,
  // and nothing that could fire on a stale timer if the rule changed.
  const match = table("public");
  tickMonsterSpawn(match);
  assert.equal(match.gameState!.monsterSpawn, null);
});

test("the same room with them on gets one on the first roll", () => {
  // The control: the only difference between this and the test above is the
  // switch, which is what makes it evidence rather than a passing assertion.
  const match = table("private");
  match.monstersEnabled = true; // opted in, the way the admin panel does it
  // ⚠️ AND PARTY MODE OUT OF THE WAY. A running minigame blocks the middle of
  // the field — that is the point of the grace — so leaving it on would make
  // this test about the party clock rather than about the monster switch.
  match.partyModeEnabled = false;
  for (let i = 0; i < FIRST_ROLL_TICKS; i++) tickMatch(match, match.tick + 1);
  assert.notEqual(match.gameState!.monster, null, "no monster with the rule on");
});

test("all three rules ride along in the lobby payload", () => {
  // The lobby draws the switches from the broadcast rather than remembering
  // what it sent, so a refused change snaps back instead of lying about the
  // room. Asserted with one of them ON: three `false`s would pass just as well
  // against a payload that had dropped the fields entirely.
  const match = table("private");
  match.partyModeEnabled = true;
  const serialized = match.serialize();
  assert.equal(serialized.monstersEnabled, false);
  assert.equal(serialized.partyModeEnabled, true);
  assert.equal(serialized.eliminatedSeeAllHealth, false);
});
