import { test } from "node:test";
import assert from "node:assert/strict";
import { ageFrom, checkAge, MINIMUM_ACCOUNT_AGE } from "../src/auth/age.js";

// The age gate. Elementals is a party game children will play, and the moment
// an account stores an email and tracks behaviour against it, COPPA and the
// GDPR's digital-consent age apply. The answer here is simply: no accounts
// under 13, and guests of any age get the whole game.

/** A fixed "now" so these tests do not change meaning as time passes. */
const NOW = new Date("2026-08-26T12:00:00Z");

/** A birth date exactly `years` before NOW, offset by `days`. */
const birthday = (years: number, days = 0) => {
  const d = new Date(NOW);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

test("age is whole years, and a birthday later this year does not count yet", () => {
  assert.equal(ageFrom(new Date("2000-08-26T00:00:00Z"), NOW), 26, "birthday today");
  assert.equal(ageFrom(new Date("2000-08-27T00:00:00Z"), NOW), 25, "tomorrow: still 25");
  assert.equal(ageFrom(new Date("2000-08-25T00:00:00Z"), NOW), 26, "yesterday: 26");
});

test("someone under 13 is refused", () => {
  const result = checkAge(birthday(12), NOW);
  assert.equal(result.ok, false);
  assert.equal(result.error, "TOO_YOUNG");
});

test("THE REFUSAL SAYS WHAT THEY CAN STILL DO", () => {
  // Being turned away from a game with no explanation is worse than being told
  // the rule and the alternative - and guests genuinely get the whole game.
  const result = checkAge(birthday(10), NOW);
  assert.match(result.message ?? "", /still play/i);
});

test("the boundary is exact: the day before the 13th birthday is too young", () => {
  assert.equal(checkAge(birthday(MINIMUM_ACCOUNT_AGE, 1), NOW).error, "TOO_YOUNG");
  assert.equal(checkAge(birthday(MINIMUM_ACCOUNT_AGE), NOW).ok, true, "on the day, allowed");
});

test("brackets are stored, never the date", () => {
  // A birth date is a strong identifier useful to nobody here. The bracket
  // answers every question a rule actually asks.
  assert.equal(checkAge(birthday(14), NOW).bracket, "13-15");
  assert.equal(checkAge(birthday(16), NOW).bracket, "16-17");
  assert.equal(checkAge(birthday(30), NOW).bracket, "18+");

  const result = checkAge(birthday(30), NOW);
  assert.deepEqual(Object.keys(result).sort(), ["bracket", "ok"], "nothing else escapes");
});

test("the EU/UK consent age is distinguishable from adulthood", () => {
  // 16-17 exists as its own bracket because the GDPR's digital-consent age is
  // 13-16 depending on member state. Collapsing it into "18+" would throw away
  // the only thing that could answer that question later.
  assert.notEqual(checkAge(birthday(17), NOW).bracket, checkAge(birthday(18), NOW).bracket);
});

test("nonsense dates are refused, not guessed at", () => {
  for (const bad of ["", "   ", "not-a-date", "2026-13-45", null, undefined, 42, {}]) {
    const result = checkAge(bad, NOW);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} should be refused`);
    assert.equal(result.error, "INVALID_DATE");
    assert.ok((result.message?.length ?? 0) > 0, "a refusal needs a message");
  }
});

test("a future birth date is refused", () => {
  assert.equal(checkAge("2030-01-01", NOW).error, "INVALID_DATE");
});

test("an implausible age is a typo, not a player", () => {
  assert.equal(checkAge("1850-01-01", NOW).error, "INVALID_DATE");
});

test("a valid date returns no message to show", () => {
  // Nothing to tell someone who answered correctly.
  const result = checkAge(birthday(25), NOW);
  assert.equal(result.ok, true);
  assert.equal(result.message, undefined);
});
