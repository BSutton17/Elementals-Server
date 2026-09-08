import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";
import { perksAllowedFor } from "../src/data/perks.js";
import type { MatchPlayer } from "../src/match/types.js";

/**
 * Copy Cat: the whole table plays one kingdom, drawn at the starting gun.
 *
 * ⚠️ THE DRAW LANDS ON THE SEATS BEFORE THE GAME STATE IS BUILT, and that is the
 * only ordering that works. `createGameState` reads each seat's kingdom to build
 * its castle, its abilities and its passives — so a draw applied afterwards
 * would leave the roster claiming one kingdom while the battlefield played
 * another, which is the kind of split that looks like nothing at all until
 * somebody casts.
 */

const seat = (id: string, kingdomId: string, perks: string[]): MatchPlayer =>
  ({
    id,
    socketId: `s-${id}`,
    name: id,
    kingdomId,
    perks,
    ready: true,
    connected: true,
  }) as never as MatchPlayer;

function room(
  seats: [string, string[]][],
  rng: () => number = () => 0,
): Match {
  const match = new Match("COPY", { rng });
  seats.forEach(([kingdom, perks], i) => match.addPlayer(seat(`p${i}`, kingdom, perks)));
  match.hostId = "p0";
  match.copyCatEnabled = true;
  return match;
}

const TWO = ["sharperSwords", "extraGuards"];

test("off by default, and the lobby's picks stand", () => {
  const match = room([["fire", TWO], ["water", TWO]]);
  match.copyCatEnabled = false;
  match.start(createMatchConfig(match));
  assert.equal(match.getPlayer("p0")!.kingdomId, "fire");
  assert.equal(match.getPlayer("p1")!.kingdomId, "water");
});

test("on, every seat ends up in the same kingdom", () => {
  const match = room([
    ["fire", TWO],
    ["water", TWO],
    ["earth", TWO],
    ["ice", TWO],
  ]);
  match.start(createMatchConfig(match));

  const kingdoms = new Set(match.getPlayers().map((p) => p.kingdomId));
  assert.equal(kingdoms.size, 1, `the table was split across ${[...kingdoms].join(", ")}`);
});

test("the battlefield is built from the drawn kingdom, not the one they picked", () => {
  // ⚠️ THE ORDERING TEST. If the draw ran after `createGameState`, the roster
  // would say one thing and every castle on the field another.
  const match = room([["fire", TWO], ["water", TWO]]);
  match.start(createMatchConfig(match));

  const drawn = match.getPlayer("p0")!.kingdomId;
  for (const player of match.gameState!.getPlayers()) {
    assert.equal(player.kingdomId, drawn, `${player.id}'s castle is not the drawn kingdom`);
  }
});

test("the kingdom comes from the match's own stream, so a seed replays it", () => {
  // Every gameplay roll goes through `match.rng` (#203). A draw that reached for
  // `Math.random` instead would make a seeded replay diverge at the first tick.
  const first = room([["fire", TWO], ["water", TWO]], () => 0.42);
  const second = room([["earth", TWO], ["ice", TWO]], () => 0.42);
  first.start(createMatchConfig(first));
  second.start(createMatchConfig(second));
  assert.equal(first.getPlayer("p0")!.kingdomId, second.getPlayer("p0")!.kingdomId);
});

test("any kingdom can come up", () => {
  // A draw pinned to one end of the list would be a very quiet bug: the mode
  // would work perfectly and always deal the same kingdom.
  const seen = new Set<string>();
  for (let i = 0; i < KINGDOM_IDS.length; i++) {
    const roll = (i + 0.5) / KINGDOM_IDS.length;
    const match = room([["fire", TWO], ["water", TWO]], () => roll);
    match.start(createMatchConfig(match));
    seen.add(match.getPlayer("p0")!.kingdomId!);
  }
  assert.equal(seen.size, KINGDOM_IDS.length, "some kingdoms can never be drawn");
});

test("a spectator is left alone", () => {
  // No castle, no kingdom. Handing one to a spectator would put them on the
  // roster as a player who never plays.
  const match = room([["fire", TWO], ["water", TWO]]);
  const watcher = seat("p2", "earth", []);
  (watcher as { spectator?: boolean }).spectator = true;
  match.addPlayer(watcher);
  match.start(createMatchConfig(match));
  assert.equal(match.getPlayer("p2")!.kingdomId, "earth", "a spectator was dealt a kingdom");
});

test("a seat never keeps more perks than its new kingdom allows", () => {
  // ⚠️ THE UNFAIR DIRECTION, AND THE ONLY ONE WORTH CORRECTING. The allowance is
  // per kingdom — Kitsune's "Three tailed fox" grants a third — so a Kitsune
  // player drawn into any other kingdom would otherwise carry an extra perk
  // nobody else has and nobody chose to give them.
  const three = [...TWO, "quickFeet"];
  // A roll that cannot land on Kitsune, so the new allowance is certainly two.
  const kitsune = KINGDOM_IDS.indexOf("kitsune");
  const other = (kitsune + 1) % KINGDOM_IDS.length;
  const match = room(
    [["kitsune", three], ["water", TWO]],
    () => (other + 0.5) / KINGDOM_IDS.length,
  );
  match.start(createMatchConfig(match));

  const drawn = match.getPlayer("p0")!.kingdomId;
  assert.notEqual(drawn, "kitsune", "the fixture drew the one kingdom it must not");
  assert.equal(
    match.getPlayer("p0")!.perks!.length,
    perksAllowedFor(drawn),
    "an over-allowance seat kept its extra perk",
  );
});

test("but a seat is never handed a perk it did not choose", () => {
  // The other direction is left alone deliberately. A table that all becomes
  // Kitsune has an allowance of three, and a player who picked two keeps two —
  // topping them up would mean the game choosing a perk on their behalf, which
  // is a worse surprise than having one fewer.
  const kitsune = KINGDOM_IDS.indexOf("kitsune");
  const match = room(
    [["fire", TWO], ["water", TWO]],
    () => (kitsune + 0.5) / KINGDOM_IDS.length,
  );
  match.start(createMatchConfig(match));

  assert.equal(match.getPlayer("p0")!.kingdomId, "kitsune", "the fixture did not draw Kitsune");
  assert.equal(match.getPlayer("p0")!.perks!.length, 2, "a perk was invented for them");
});

test("it rides along in the lobby payload", () => {
  // The panel draws its switches from the broadcast rather than remembering
  // what it sent, so a refused change snaps back instead of lying.
  const match = room([["fire", TWO], ["water", TWO]]);
  assert.equal(match.serialize().copyCatEnabled, true);
  match.copyCatEnabled = false;
  assert.equal(match.serialize().copyCatEnabled, false);
});

test("a matchmade room never turns it on by itself", () => {
  const publicRoom = new Match("PUB", { visibility: "public" });
  assert.equal(publicRoom.copyCatEnabled, false);
});
