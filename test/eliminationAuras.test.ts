import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { processDeaths } from "../src/engine/elimination.js";
import { earn } from "../src/engine/money.js";
import { FIREFLIES } from "../src/data/lightAbilities.js";
import type { GameplayEvent } from "../src/engine/events.js";
import type { MatchPlayer } from "../src/match/types.js";
import { mulberry32 } from "../simulation/src/rng.js";

/**
 * A kingdom that dies carrying an endless aura must ANNOUNCE that the aura is
 * over.
 *
 * ⚠️ THE VISUAL LAYER HAS NO OTHER WAY TO KNOW. It starts a swarm on
 * `statusApplied` and stops it on `statusExpired`; Fireflies and Old Friends
 * have no natural lifetime, so `statusExpired` is the ONLY message that ends
 * them. Elimination used to clear `player.statuses` silently, and a swarm cast
 * on a kingdom that then died went on dancing over the ruin for the rest of the
 * match.
 */

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: null,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

function arena() {
  const match = new Match("ELIM", { rng: mulberry32(11) });
  match.addPlayer(player("a", "light"));
  match.addPlayer(player("b", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const state = match.gameState!;
  const events: GameplayEvent[] = [];
  state.events.on((e) => events.push(e));
  earn(state.getPlayer("a")!, 100_000);
  return { match, state, events };
}

test("a kingdom eliminated while swarmed reports the swarm as expired", () => {
  const { match, state, events } = arena();
  const victim = state.getPlayer("b")!;

  assert.equal(activateAbility(match, state.getPlayer("a")!, FIREFLIES, { targetId: "b" }).ok, true);
  assert.ok(
    victim.statuses.some((s) => s.id === "fireflies"),
    "the swarm should have settled",
  );

  victim.castle.hp = 0;
  processDeaths(match);

  const expired = events.filter(
    (e) => e.type === "statusExpired" && e.playerId === "b" && e.statusId === "fireflies",
  );
  assert.equal(expired.length, 1, "the swarm was cleared without ever being announced");
  assert.deepEqual(victim.statuses, []);
});

test("every status a dying kingdom carried is announced, not just the endless ones", () => {
  // The fix is deliberately general: the three that were noticed are the ones
  // with no clock, but nothing here should have to know which those are.
  const { match, state, events } = arena();
  const victim = state.getPlayer("b")!;
  victim.statuses = [
    { id: "fireflies", name: "Fireflies", category: "debuff", remainingTicks: 72_000, stacks: 1 },
    { id: "burn", name: "Burn", category: "debuff", remainingTicks: 40, stacks: 2 },
  ] as typeof victim.statuses;

  victim.castle.hp = 0;
  processDeaths(match);

  const ids = events
    .filter((e) => e.type === "statusExpired" && e.playerId === "b")
    .map((e) => (e as { statusId: string }).statusId)
    .sort();
  assert.deepEqual(ids, ["burn", "fireflies"]);
});

test("a kingdom with nothing on it emits nothing extra when it dies", () => {
  const { match, state, events } = arena();
  state.getPlayer("b")!.castle.hp = 0;
  processDeaths(match);
  assert.equal(events.filter((e) => e.type === "statusExpired").length, 0);
  assert.equal(events.filter((e) => e.type === "eliminated").length, 1);
});
