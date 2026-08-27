import { test } from "node:test";
import assert from "node:assert/strict";
import { placementsFor } from "../src/match/matchResult.js";
import type { PlayerState } from "../src/match/playerState.js";

// Placement: the one piece of the match result that is derived rather than
// counted, so it is the one that can be wrong in a way nobody notices.

/** A stand-in carrying only the two fields placement reads. */
const seat = (id: string, eliminatedAtTick: number | null) =>
  ({ id, eliminatedAtTick }) as PlayerState;

const place = (players: PlayerState[]) => placementsFor(players);

test("the survivor is first, and the rest rank by how long they lasted", () => {
  const p = place([
    seat("winner", null),
    seat("second", 900), // fell last of the fallen
    seat("third", 500),
    seat("fourth", 100), // fell first
  ]);
  assert.equal(p.get("winner"), 1);
  assert.equal(p.get("second"), 2);
  assert.equal(p.get("third"), 3);
  assert.equal(p.get("fourth"), 4);
});

test("outlasting someone always places you above them", () => {
  // The property that matters, stated directly: placement is a function of
  // survival time and nothing else.
  const players = [seat("a", 300), seat("b", 100), seat("c", null), seat("d", 200)];
  const p = place(players);
  const byPlacement = [...p.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
  assert.deepEqual(byPlacement, ["c", "a", "d", "b"]);
});

test("A DRAW TIES ITS SURVIVORS RATHER THAN INVENTING AN ORDER", () => {
  // Mutual elimination can leave several kingdoms standing. Ordering them by
  // seat index or leftover HP would report a result the game never produced.
  const p = place([seat("x", null), seat("y", null), seat("z", 400)]);
  assert.equal(p.get("x"), 1);
  assert.equal(p.get("y"), 1);
  // Competition ranking: two firsts means the next place is third, not second.
  assert.equal(p.get("z"), 3);
});

test("kingdoms that fell on the same tick share a placement", () => {
  const p = place([seat("alive", null), seat("a", 500), seat("b", 500), seat("c", 200)]);
  assert.equal(p.get("alive"), 1);
  assert.equal(p.get("a"), 2);
  assert.equal(p.get("b"), 2, "same tick is a genuine tie");
  assert.equal(p.get("c"), 4, "and the next place skips one");
});

test("every player is placed, with no gaps at the top", () => {
  const players = [seat("a", null), seat("b", 10), seat("c", 20), seat("d", 30)];
  const p = place(players);
  assert.equal(p.size, players.length);
  assert.equal(Math.min(...p.values()), 1, "somebody is always first");
});

test("a total wipe leaves nobody first", () => {
  // Everyone dead, nobody survived: the earliest placement is 1 for whoever
  // lasted longest, because they did outlast the others.
  const p = place([seat("a", 100), seat("b", 200)]);
  assert.equal(p.get("b"), 1);
  assert.equal(p.get("a"), 2);
});

test("a solo match places the only player first", () => {
  assert.equal(place([seat("lonely", null)]).get("lonely"), 1);
});
