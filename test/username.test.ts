import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUsername, usernameKey, USERNAME_MIN, USERNAME_MAX } from "../src/auth/username.js";

// Username rules.
//
// A username is not the in-match display name: it is permanent, unique, and
// shown to strangers. These tests pin the rules that make it safe to treat as
// an identity.

const ok = (value: string) => {
  const result = checkUsername(value);
  assert.equal(result.ok, true, `${JSON.stringify(value)} should be allowed`);
  return result;
};

const rejects = (value: unknown, error: string) => {
  const result = checkUsername(value);
  assert.equal(result.ok, false, `${JSON.stringify(value)} should be refused`);
  assert.equal(result.error, error);
  // Every refusal must be explainable to the player. A rule they cannot see is
  // a rule they cannot satisfy.
  assert.ok((result.message?.length ?? 0) > 0, "a refusal needs a message");
};

test("ordinary names are accepted", () => {
  for (const name of ["Bryson", "bry_son", "kingdom-42", "aaa", "a1", "A".repeat(USERNAME_MAX)]) {
    if (name.length >= USERNAME_MIN) ok(name);
  }
});

test("surrounding whitespace is trimmed, not rejected", () => {
  assert.equal(ok("  Bryson  ").username, "Bryson");
});

test("length is bounded at both ends", () => {
  rejects("ab", "TOO_SHORT");
  rejects("A".repeat(USERNAME_MAX + 1), "TOO_LONG");
});

test("SPACES ARE REFUSED - they are an impersonation tool", () => {
  // "Bryson" and "Bry son" must not both exist: to every human reading a lobby
  // they are the same name. Interior whitespace fails the character rule.
  rejects("Bry son", "INVALID_CHARACTERS");
  rejects("Bry son", "INVALID_CHARACTERS"); // interior non-breaking space
  rejects("Bry	son", "INVALID_CHARACTERS");
});

test("exotic whitespace on the EDGES is trimmed away, closing the same hole", () => {
  // A trailing non-breaking space is the classic impersonation trick, and it is
  // defeated one step earlier: `trim()` covers Unicode whitespace, so this
  // reduces to plain "Bryson" - which then collides with the real Bryson on the
  // unique index and is refused as TAKEN. Two different mechanisms, same
  // outcome, and this test exists so neither is removed as redundant.
  assert.equal(checkUsername("Bryson ").username, "Bryson");
  assert.equal(checkUsername(" Bryson ").username, "Bryson");
});

test("other punctuation and symbols are refused", () => {
  for (const bad of ["Bry.son", "Bry@son", "<script>", "Bry/son", "emoji🙂"]) {
    rejects(bad, "INVALID_CHARACTERS");
  }
});

test("separators cannot sit on the edges", () => {
  rejects("_bryson", "BAD_EDGES");
  rejects("bryson-", "BAD_EDGES");
});

test("impersonation names are reserved", () => {
  for (const bad of ["admin", "ADMIN", "Moderator", "system", "guest"]) {
    rejects(bad, "RESERVED");
  }
});

test("reserved matching is exact, not a substring", () => {
  // Banning "admin" as a substring would also ban "admiral", which is a real
  // word people want.
  ok("admiral");
  ok("modest");
});

test("obvious profanity is refused, including spaced-out spellings", () => {
  rejects("shit", "PROFANITY");
  rejects("s-h-i-t", "PROFANITY");
  rejects("F_U_C_K", "PROFANITY");
});

test("non-strings are refused rather than coerced", () => {
  for (const bad of [null, undefined, 42, {}, []]) rejects(bad, "INVALID_CHARACTERS");
});

test("uniqueness is keyed case-insensitively", () => {
  // Otherwise "Bryson" and "bryson" are two players to the database and one
  // player to everybody else.
  assert.equal(usernameKey("Bryson"), usernameKey("BRYSON"));
  assert.equal(usernameKey("Bryson"), "bryson");
});
