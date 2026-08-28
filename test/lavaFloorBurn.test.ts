import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { FLOOR_IS_LAVA } from "../src/data/magmaAbilities.js";
import { MAGMA, TICK } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";
import { mulberry32 } from "../simulation/src/rng.js";

/**
 * "Floor is Lava" now cooks the ground it lights, on top of fanning every burn
 * already on the field.
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
  const match = new Match("LAVA", { rng: mulberry32(3) });
  match.addPlayer(player("m", "magma"));
  match.addPlayer(player("b", "water"));
  match.addPlayer(player("c", "nature"));
  match.hostId = "m";
  match.start(createMatchConfig(match));
  const state = match.gameState!;
  earn(state.getPlayer("m")!, 100_000);
  return { match, state };
}

test("lighting the floor puts a burn on every other kingdom, and none on Magma", () => {
  const { match, state } = arena();
  assert.equal(activateAbility(match, state.getPlayer("m")!, FLOOR_IS_LAVA, {}).ok, true);

  for (const id of ["b", "c"]) {
    assert.ok(
      state.getPlayer(id)!.statuses.some((s) => s.id === "lavaFloorBurn"),
      `${id} should be standing on lava`,
    );
  }
  // Magma walks on its own floor unburned — the same exemption the burn
  // multiplier makes.
  assert.equal(
    state.getPlayer("m")!.statuses.some((s) => s.id === "lavaFloorBurn"),
    false,
  );
});

test("the floor deals its stated 6 a tick, not the multiplied 9", () => {
  // ⚠️ THE POINT OF THIS TEST. The other half of the ability multiplies every
  // burn on the field by 1.5; if the floor's own damage were flagged as a burn
  // it would fan itself and quietly land at 9.
  const { match, state } = arena();
  const victim = state.getPlayer("b")!;
  victim.castle.shield = 0;
  activateAbility(match, state.getPlayer("m")!, FLOOR_IS_LAVA, {});

  const before = victim.castle.hp;
  tickMatch(match, match.tick + 1);
  assert.equal(before - victim.castle.hp, MAGMA.LAVA_FLOOR_TICK_DAMAGE);
});

test("the burn ends with the floor rather than outliving it", () => {
  const { match, state } = arena();
  activateAbility(match, state.getPlayer("m")!, FLOOR_IS_LAVA, {});
  const victim = state.getPlayer("b")!;
  const status = victim.statuses.find((s) => s.id === "lavaFloorBurn")!;
  // Same clock as the molten field: 21 s, both set from one number.
  assert.equal(status.remainingTicks, Math.round(21 * TICK.RATE));
});

test("an already-dead kingdom is not set alight", () => {
  const { match, state } = arena();
  const dead = state.getPlayer("c")!;
  dead.eliminated = true;
  activateAbility(match, state.getPlayer("m")!, FLOOR_IS_LAVA, {});
  assert.equal(dead.statuses.some((s) => s.id === "lavaFloorBurn"), false);
});
