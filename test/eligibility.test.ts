import { test } from "node:test";
import assert from "node:assert/strict";
import { capped, eligibilityFor, ELIGIBILITY } from "../src/engine/eligibility.js";
import type { MatchParticipantResult, MatchResult } from "../src/match/matchResult.js";

// The anti-farm gates. Every one of these exists because of a specific way
// somebody would otherwise manufacture coins, and each test names it.

const seat = (over: Partial<MatchParticipantResult["stats"]> = {}): MatchParticipantResult =>
  ({
    playerId: "me",
    stats: {
      damageDealt: 5000,
      damageTaken: 1000,
      damageShielded: 500,
      healingDone: 0,
      goldEarned: 2000,
      goldSpent: 1500,
      abilitiesCast: 40,
      killsCredited: 1,
      ...over,
    },
  }) as MatchParticipantResult;

const match = (seconds: number): MatchResult =>
  ({ durationTicks: seconds * 20, tickRate: 20 }) as MatchResult;

const long = match(600);

test("an ordinary public match pays in full", () => {
  const result = eligibilityFor(seat(), long, false);
  assert.equal(result.earns, true);
  assert.equal(result.rate, 1);
});

test("CONCEDING INSTANTLY ON REPEAT EARNS NOTHING", () => {
  // The fastest farm there is: open a room, concede, repeat.
  const short = eligibilityFor(seat(), match(ELIGIBILITY.MIN_SECONDS - 1), false);
  assert.equal(short.earns, false);
  assert.equal(short.reason, "TOO_SHORT");
});

test("a match just past the threshold does pay", () => {
  assert.equal(eligibilityFor(seat(), match(ELIGIBILITY.MIN_SECONDS + 1), false).earns, true);
});

test("SITTING IN A LOBBY DOING NOTHING EARNS NOTHING", () => {
  const idle = eligibilityFor(seat({ abilitiesCast: 0, goldSpent: 0 }), long, false);
  assert.equal(idle.earns, false);
  assert.equal(idle.reason, "INACTIVE");
});

test("the activity floor needs BOTH halves, not either", () => {
  // Two conditions because they are dodged differently: a script can spam a
  // cheap ability, and an idle player still accrues gold. Having to do both is
  // a far better filter than either alone.
  const casterOnly = eligibilityFor(seat({ goldSpent: 0 }), long, false);
  assert.equal(casterOnly.earns, false, "casting without spending is not playing");

  const spenderOnly = eligibilityFor(seat({ abilitiesCast: 0 }), long, false);
  assert.equal(spenderOnly.earns, false, "spending without casting is not playing");
});

test("the floor is low enough that a real player never trips it", () => {
  // Someone who played badly and died early still cast a few things.
  const modest = eligibilityFor(
    seat({ abilitiesCast: ELIGIBILITY.MIN_ABILITIES_CAST, goldSpent: ELIGIBILITY.MIN_GOLD_SPENT }),
    long,
    false,
  );
  assert.equal(modest.earns, true);
});

test("private rooms pay a reduced rate, but they do pay", () => {
  // They are the game's heart - a code read aloud to friends - but also the
  // only place a lobby can be curated.
  const priv = eligibilityFor(seat(), long, true);
  assert.equal(priv.earns, true);
  assert.equal(priv.rate, ELIGIBILITY.PRIVATE_ROOM_RATE);
  assert.ok(priv.rate > 0 && priv.rate < 1);
});

test("an ineligible private match is still reported as private", () => {
  // The rate travels with the verdict, so a caller cannot accidentally pay a
  // private room the public rate on some other path.
  const result = eligibilityFor(seat(), match(10), true);
  assert.equal(result.earns, false);
  assert.equal(result.rate, ELIGIBILITY.PRIVATE_ROOM_RATE);
});

// --- the daily cap -----------------------------------------------------------

test("the cap turns unlimited farming into bounded farming", () => {
  assert.equal(capped(500, 0, 2000), 500, "nothing earned yet: pay in full");
  assert.equal(capped(500, 1800, 2000), 200, "near the cap: pay what is left");
  assert.equal(capped(500, 2000, 2000), 0, "at the cap: pay nothing");
  assert.equal(capped(500, 9999, 2000), 0, "past the cap: still nothing, never negative");
});

test("the cap never pays a negative or fractional amount", () => {
  assert.equal(capped(-50, 0, 2000), 0);
  assert.equal(capped(10.6, 0, 2000), 11);
});
