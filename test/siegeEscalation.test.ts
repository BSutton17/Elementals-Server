import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickSiegeWatches, siegeEscalation } from "../src/engine/siege.js";
import { besiegedStacks, besiegedDamageMultiplier } from "../src/engine/passives.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { COMBAT, TICK } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

// Persistent-siege escalation: two kingdoms aiming at you at the same moment is
// coincidence, so the raw curve barely reacts. Two kingdoms STILL on you a
// minute later is a team, and this is what pays the victim for it.
//
// See `engine/siege.ts` for the three rules these tests exist to pin down:
// same members, a look-away pauses rather than resets, and earned stages are a
// floor that a rotating cast cannot strip.

const TIER1 = COMBAT.SIEGE_ESCALATION_TIER_SECONDS[0]! * TICK.RATE; // 1 minute
const TIER2 = COMBAT.SIEGE_ESCALATION_TIER_SECONDS[1]! * TICK.RATE; // 3 minutes
const GRACE = COMBAT.SIEGE_ABSENCE_GRACE_SECONDS * TICK.RATE; // 10 s

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

function arena(n: number): { match: Match; players: PlayerState[] } {
  const match = new Match("1234");
  for (let i = 0; i < n; i++) match.addPlayer(player(`p${i}`, "plains"));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  match.tick = 1000;
  const gs = match.gameState!;
  const players = Array.from({ length: n }, (_, i) => gs.getPlayer(`p${i}`)!);
  for (const p of players) earn(p, 100_000);
  return { match, players };
}

/**
 * Targets are set directly rather than through `selectTarget`, so these tests
 * are about the siege watch and not about the target-switch cooldown. The
 * cooldown is `targeting.test.ts`'s subject.
 */
function aim(attackers: PlayerState[], victim: PlayerState | null): void {
  for (const a of attackers) a.target = victim ? victim.id : null;
}

/** Advances `ticks` siege-watch ticks. */
function hold(match: Match, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    match.tick += 1;
    tickSiegeWatches(match);
  }
}

/** Points `attackers` at `victim` and lets the watch pick the coalition up. */
function beginSiege(match: Match, victim: PlayerState, attackers: PlayerState[]): void {
  aim(attackers, victim);
  hold(match, 1); // the pick-up tick: coalition tracked, held time still zero
}

// --- Earning the stages -------------------------------------------------------

test("a short double-team earns nothing - coincidence is not a coalition", () => {
  const { match, players } = arena(4);
  const [victim, a, b] = players;
  beginSiege(match, victim!, [a!, b!]);

  hold(match, TIER1 - 1);
  assert.equal(siegeEscalation(victim!), 0);
  assert.equal(besiegedStacks(victim!, match.gameState!.getPlayers()), 1);
});

test("the same two kingdoms holding for a minute earn one extra stage", () => {
  const { match, players } = arena(4);
  const [victim, a, b] = players;
  const all = match.gameState!.getPlayers();
  beginSiege(match, victim!, [a!, b!]);

  hold(match, TIER1);
  assert.equal(siegeEscalation(victim!), 1);
  // Two attackers now pay what three would: stack 1 becomes stack 2.
  assert.equal(besiegedStacks(victim!, all), 2);
  assert.equal(
    besiegedDamageMultiplier(victim!, all),
    COMBAT.BESIEGED_DAMAGE_CURVE[1],
  );
});

test("holding for three minutes earns a second stage, and never a third", () => {
  const { match, players } = arena(4);
  const [victim, a, b] = players;
  beginSiege(match, victim!, [a!, b!]);

  hold(match, TIER2);
  assert.equal(siegeEscalation(victim!), 2);
  assert.equal(besiegedStacks(victim!, match.gameState!.getPlayers()), 3);

  // Another five minutes buys nothing: two tiers is the whole ladder.
  hold(match, 5 * 60 * TICK.RATE);
  assert.equal(siegeEscalation(victim!), 2);
  assert.equal(
    COMBAT.SIEGE_ESCALATION_TIER_SECONDS.length,
    2,
    "the tier table is what caps escalation - adding an entry changes the rule",
  );
});

test("three and four kingdoms escalate too", () => {
  for (const size of [3, 4]) {
    const { match, players } = arena(6);
    const victim = players[0]!;
    const attackers = players.slice(1, 1 + size);
    beginSiege(match, victim, attackers);
    hold(match, TIER1);
    assert.equal(siegeEscalation(victim), 1, `${size} attackers should escalate`);
    assert.equal(besiegedStacks(victim, match.gameState!.getPlayers()), size);
  }
});

test("a five-kingdom pile-on does not escalate - that is just a free-for-all", () => {
  const { match, players } = arena(7);
  const victim = players[0]!;
  beginSiege(match, victim, players.slice(1, 6)); // five attackers
  hold(match, TIER2);
  assert.equal(siegeEscalation(victim), 0);
  // The raw curve is already doing the work at that many attackers.
  assert.equal(besiegedStacks(victim, match.gameState!.getPlayers()), 4);
});

// --- Rule 1: it has to be the same kingdoms -----------------------------------

test("swapping a member at the last moment restarts the clock", () => {
  const { match, players } = arena(5);
  const [victim, a, b, c] = players;
  beginSiege(match, victim!, [a!, b!]);

  hold(match, TIER1 - 5 * TICK.RATE); // 55 seconds in
  assert.equal(siegeEscalation(victim!), 0);

  // Water steps off, Insects steps on: still two attackers, different team.
  aim([b!], null);
  aim([c!], victim!);
  hold(match, 5 * TICK.RATE); // the original minute elapses - but not for THIS pair
  assert.equal(siegeEscalation(victim!), 0);

  // The new pair has to serve its own minute.
  hold(match, TIER1);
  assert.equal(siegeEscalation(victim!), 1);
});

// --- Rule 2: a look-away pauses, it does not reset -----------------------------

test("a brief look-away pauses the clock and resumes where it left off", () => {
  const { match, players } = arena(4);
  const [victim, a, b] = players;
  beginSiege(match, victim!, [a!, b!]);

  hold(match, TIER1 - 100); // 100 ticks short
  aim([b!], null);
  hold(match, 5 * TICK.RATE); // away 5 s, well inside the grace
  assert.equal(siegeEscalation(victim!), 0, "the away time must not count");

  aim([b!], victim!);
  hold(match, 99);
  assert.equal(siegeEscalation(victim!), 0, "still one tick short");
  hold(match, 1);
  assert.equal(siegeEscalation(victim!), 1, "resumed, not restarted");
});

test("looking away for longer than the grace restarts the clock", () => {
  const { match, players } = arena(4);
  const [victim, a, b] = players;
  beginSiege(match, victim!, [a!, b!]);

  hold(match, TIER1 - 100);
  aim([b!], null);
  hold(match, GRACE + 2 * TICK.RATE); // gone too long
  aim([b!], victim!);
  hold(match, 200);
  assert.equal(siegeEscalation(victim!), 0, "that is a new siege, not a resumed one");

  hold(match, TIER1);
  assert.equal(siegeEscalation(victim!), 1);
});

test("flickering off and on cannot hold the clock at zero forever", () => {
  // The abuse the grace exists to kill: drop a member briefly, over and over,
  // hoping each dip resets the timer. With pause semantics each dip costs the
  // coalition exactly the time it was away, so the stage still lands.
  const { match, players } = arena(4);
  const [victim, a, b] = players;
  beginSiege(match, victim!, [a!, b!]);

  let elapsed = 0;
  while (elapsed < TIER1 * 2) {
    hold(match, 100);
    aim([b!], null);
    hold(match, 5); // a quarter-second dip
    aim([b!], victim!);
    elapsed += 105;
  }
  assert.equal(siegeEscalation(victim!), 1, "the dips only delayed it");
});

// --- Rule 3: earned stages are a floor ----------------------------------------

test("a third kingdom joining an escalated siege raises the stage again", () => {
  const { match, players } = arena(5);
  const [victim, a, b, c] = players;
  const all = match.gameState!.getPlayers();
  beginSiege(match, victim!, [a!, b!]);
  hold(match, TIER1);
  assert.equal(besiegedStacks(victim!, all), 2); // 1 raw + 1 earned

  aim([c!], victim!);
  hold(match, 1);
  // Raw goes to 2, the earned stage stays as a floor: 3, not back to 2.
  assert.equal(siegeEscalation(victim!), 1);
  assert.equal(besiegedStacks(victim!, all), 3);
});

test("rotating members cannot strip an earned stage", () => {
  const { match, players } = arena(5);
  const [victim, a, b, c] = players;
  beginSiege(match, victim!, [a!, b!]);
  hold(match, TIER1);
  assert.equal(siegeEscalation(victim!), 1);

  // Swap one attacker for a fresh one - the clock restarts, the stage does not.
  aim([b!], null);
  aim([c!], victim!);
  hold(match, 2 * TICK.RATE);
  assert.equal(siegeEscalation(victim!), 1, "the floor held");
  assert.equal(besiegedStacks(victim!, match.gameState!.getPlayers()), 2);
});

test("the floor is released once the siege actually ends", () => {
  const { match, players } = arena(4);
  const [victim, a, b] = players;
  beginSiege(match, victim!, [a!, b!]);
  hold(match, TIER1);
  assert.equal(siegeEscalation(victim!), 1);

  aim([a!, b!], null);
  hold(match, GRACE + 2 * TICK.RATE);
  assert.equal(siegeEscalation(victim!), 0, "nobody is besieging - no floor to keep");
});

test("dropping to one attacker briefly does NOT release the floor", () => {
  // Otherwise the reset denied at the composition check would be handed back
  // here: one member steps off for five seconds and the stage evaporates.
  const { match, players } = arena(4);
  const [victim, a, b] = players;
  beginSiege(match, victim!, [a!, b!]);
  hold(match, TIER1);

  aim([b!], null);
  hold(match, 5 * TICK.RATE);
  assert.equal(siegeEscalation(victim!), 1);
  aim([b!], victim!);
  hold(match, 1);
  assert.equal(besiegedStacks(victim!, match.gameState!.getPlayers()), 2);
});

// --- Invariants that must survive escalation ----------------------------------

test("a fair 1v1 is never escalated, even with a stage banked", () => {
  const { match, players } = arena(4);
  const [victim, a, b] = players;
  const all = match.gameState!.getPlayers();
  beginSiege(match, victim!, [a!, b!]);
  hold(match, TIER1);
  assert.equal(siegeEscalation(victim!), 1);

  // One walks away. Inside the grace the FLOOR survives (above), but a single
  // attacker must still be a neutral fight - escalation applies to a siege, and
  // one enemy is not a siege.
  aim([b!], null);
  hold(match, 2 * TICK.RATE);
  assert.equal(besiegedStacks(victim!, all), 0);
  assert.equal(besiegedDamageMultiplier(victim!, all), 1);
});

test("escalation cannot push past the curve's last stage", () => {
  const { match, players } = arena(7);
  const victim = players[0]!;
  const all = match.gameState!.getPlayers();
  // Four attackers earn two stages, then everyone else piles on.
  beginSiege(match, victim, players.slice(1, 5));
  hold(match, TIER2);
  assert.equal(siegeEscalation(victim), 2);

  aim(players.slice(5), victim);
  hold(match, 1);
  const stacks = besiegedStacks(victim, all);
  assert.equal(stacks, COMBAT.BESIEGED_MAX_STACKS);
  assert.ok(
    COMBAT.BESIEGED_DAMAGE_CURVE[stacks - 1] !== undefined,
    "a stack count with no curve entry would read off the end of the table",
  );
});

test("an eliminated attacker does not hold a seat in the coalition", () => {
  const { match, players } = arena(5);
  const [victim, a, b, c] = players;
  beginSiege(match, victim!, [a!, b!]);
  hold(match, TIER1 - 100);

  // Killing an attacker is not a look-away: they are never coming back, so the
  // coalition is genuinely different immediately rather than in ten seconds.
  b!.eliminated = true;
  aim([c!], victim!);
  hold(match, 200);
  assert.equal(siegeEscalation(victim!), 0);
});

test("an eliminated victim's watch is cleared", () => {
  const { match, players } = arena(4);
  const [victim, a, b] = players;
  beginSiege(match, victim!, [a!, b!]);
  hold(match, TIER1);
  assert.equal(siegeEscalation(victim!), 1);

  victim!.eliminated = true;
  hold(match, 1);
  assert.equal(siegeEscalation(victim!), 0);
});

// --- Wiring -------------------------------------------------------------------

test("the real tick loop advances the siege watch", () => {
  // Everything above drives `tickSiegeWatches` directly; this proves the phase
  // is actually wired into `tickMatch`, and runs before income so a stage is
  // worth gold on the tick it lands.
  const { match, players } = arena(4);
  const [victim, a, b] = players;
  aim([a!, b!], victim!);

  const start = match.tick;
  for (let t = start + 1; t <= start + TIER1 + 2; t++) {
    tickMatch(match, t);
    if (victim!.eliminated) break;
  }
  assert.equal(siegeEscalation(victim!), 1);
});
