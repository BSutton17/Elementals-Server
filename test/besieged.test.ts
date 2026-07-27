import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { besiegedDamageMultiplier, besiegedIncomePerTick } from "../src/engine/passives.js";
import { applyPassiveIncome } from "../src/engine/economy.js";
import { withParameterSet } from "../src/engine/parameters.js";
import { selectTarget } from "../src/engine/targeting.js";
import { earn } from "../src/engine/money.js";
import { WATER_BALL } from "../src/data/waterAbilities.js";
import { COMBAT, TICK } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

// "Besieged" comeback: the more enemies are targeting you, the harder your own
// attacks hit. A fair 1v1 is neutral; being ganged up on scales the bonus.

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** A match of N plains kingdoms (p0..p{N-1}), all funded, switch cooldowns clear. */
function arena(n: number): { match: Match; players: PlayerState[] } {
  const match = new Match("1234");
  for (let i = 0; i < n; i++) match.addPlayer(player(`p${i}`, "plains"));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  match.tick = 1000; // past every target-switch cooldown
  const gs = match.gameState!;
  const players = Array.from({ length: n }, (_, i) => gs.getPlayer(`p${i}`)!);
  for (const p of players) earn(p, 100_000);
  return { match, players };
}

test("no bonus when nobody, or only one enemy, is targeting you", () => {
  const { match, players } = arena(4);
  const [me, a] = players;
  assert.equal(besiegedDamageMultiplier(me, match.gameState!.getPlayers()), 1);

  selectTarget(match, a, me.id); // a single besieger — a fair fight, still ×1
  assert.equal(besiegedDamageMultiplier(me, match.gameState!.getPlayers()), 1);
});

test("each enemy beyond the first adds the per-attacker bonus", () => {
  const { match, players } = arena(4);
  const [me, a, b, c] = players;
  const all = match.gameState!.getPlayers();

  selectTarget(match, a, me.id);
  selectTarget(match, b, me.id); // 2 besiegers -> 1 stack
  assert.equal(
    besiegedDamageMultiplier(me, all),
    1 + COMBAT.BESIEGED_DAMAGE_PER_ATTACKER,
  );

  selectTarget(match, c, me.id); // 3 besiegers -> 2 stacks
  assert.equal(
    besiegedDamageMultiplier(me, all),
    1 + 2 * COMBAT.BESIEGED_DAMAGE_PER_ATTACKER,
  );
});

test("eliminated attackers and non-targeters don't count", () => {
  const { match, players } = arena(4);
  const [me, a, b, c] = players;
  const all = match.gameState!.getPlayers();

  selectTarget(match, a, me.id);
  selectTarget(match, b, me.id);
  selectTarget(match, c, me.id); // 3 besiegers -> 2 stacks
  b.eliminated = true; // down to 2 living besiegers -> 1 stack
  assert.equal(
    besiegedDamageMultiplier(me, all),
    1 + COMBAT.BESIEGED_DAMAGE_PER_ATTACKER,
  );
});

test("the bonus is capped: extra besiegers past the cap add nothing", () => {
  // A full lobby: 7 enemies pile onto one kingdom (7 besiegers -> 6 stacks).
  const { match, players } = arena(8);
  const me = players[0];
  for (let i = 1; i < 8; i++) selectTarget(match, players[i], me.id);
  const all = match.gameState!.getPlayers();

  // Lower the cap to 2 stacks: the 7 besiegers clamp down to it.
  withParameterSet({ "combat.besiegedMaxStacks": 2 }, () => {
    assert.equal(
      besiegedDamageMultiplier(me, all),
      1 + 2 * COMBAT.BESIEGED_DAMAGE_PER_ATTACKER,
    );
  });

  // At the real cap (6), a full 8-player gang lands exactly on it.
  assert.equal(
    besiegedDamageMultiplier(me, all),
    1 + COMBAT.BESIEGED_MAX_STACKS * COMBAT.BESIEGED_DAMAGE_PER_ATTACKER,
  );
});

// --- Besieged defensive income ------------------------------------------------------

test("besieged grants no bonus income in a fair 1v1, but pays out when ganged up on", () => {
  const { match, players } = arena(4);
  const [me, a, b, c] = players;
  const all = match.gameState!.getPlayers();

  assert.equal(besiegedIncomePerTick(me, all), 0); // nobody targeting
  selectTarget(match, a, me.id);
  assert.equal(besiegedIncomePerTick(me, all), 0); // one attacker — still nothing

  selectTarget(match, b, me.id); // 2 besiegers -> 1 stack
  assert.equal(
    besiegedIncomePerTick(me, all),
    COMBAT.BESIEGED_INCOME_PER_ATTACKER / TICK.RATE,
  );

  selectTarget(match, c, me.id); // 3 besiegers -> 2 stacks
  assert.equal(
    besiegedIncomePerTick(me, all),
    (2 * COMBAT.BESIEGED_INCOME_PER_ATTACKER) / TICK.RATE,
  );
});

test("the passive-income phase adds the besieged bonus to earnings", () => {
  const { match, players } = arena(4);
  const [me, a, b] = players;
  selectTarget(match, a, me.id);
  selectTarget(match, b, me.id); // 1 besieged stack on `me`

  me.economy.currency = 0;
  const bonusPerTick = COMBAT.BESIEGED_INCOME_PER_ATTACKER / TICK.RATE;
  applyPassiveIncome(match.gameState!);
  // Earned = base income (from citizens) + the besieged defensive bonus, and
  // the HUD's incomePerTick reflects the boost.
  assert.ok(me.economy.currency > 0);
  assert.ok(
    Math.abs(me.economy.currency - me.economy.incomePerTick) < 1e-9,
    "earned exactly the (boosted) per-tick income",
  );
  // A besieged player out-earns an un-besieged twin with the same citizens.
  const c = players[3];
  c.economy.currency = 0;
  c.economy.citizens = me.economy.citizens;
  applyPassiveIncome(match.gameState!);
  assert.ok(
    me.economy.incomePerTick - c.economy.incomePerTick > bonusPerTick - 1e-9,
    "besieged income exceeds the un-besieged baseline by the bonus",
  );
});

test("a besieged attacker's Water Ball hits harder end to end", () => {
  const { match, players } = arena(4);
  const [me, a, b, c] = players;

  // Two enemies pile onto `me` (1 stack = +10%); `me` fires at a third.
  selectTarget(match, a, me.id);
  selectTarget(match, b, me.id);
  c.castle.hp = 10_000;
  activateAbility(match, me, WATER_BALL, { targetId: c.id, forceCrit: false });
  assert.equal(c.castle.hp, 10_000 - 330); // 300 × 1.10
});
