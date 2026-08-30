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

test("a private room has monsters, a public one does not", () => {
  // ⚠️ THE DEFAULT IS THE RULE FOR PUBLIC ROOMS, not a starting point someone
  // can move. A monster is a shared emergency that costs the whole table gold
  // and attention; a table of friends can agree to that, and a stranger who
  // queued for a free-for-all did not.
  assert.equal(table("private").monstersEnabled, true);
  assert.equal(table("public").monstersEnabled, false);
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
  for (let i = 0; i < FIRST_ROLL_TICKS; i++) tickMatch(match, match.tick + 1);
  assert.notEqual(match.gameState!.monster, null, "no monster with the rule on");
});

test("both rules ride along in the lobby payload", () => {
  // The lobby draws the switches from the broadcast rather than remembering
  // what it sent, so a refused change snaps back instead of lying about the
  // room.
  const serialized = table("private").serialize();
  assert.equal(serialized.monstersEnabled, true);
  assert.equal(serialized.eliminatedSeeAllHealth, false);
});
