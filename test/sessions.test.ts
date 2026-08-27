import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { startServer, type RunningServer } from "./helpers/server.js";

/**
 * Session tokens, and the sliding expiry that keeps players signed in.
 *
 * ⚠️ THE BEHAVIOUR UNDER TEST IS "A PLAYER WHO KEEPS PLAYING IS NEVER LOGGED
 * OUT". The lifetime used to be a fixed 30 days from sign-in, which meant
 * someone who opened the game every single day was still thrown out on day 31.
 * `renewSessionToken` re-issues a token once it is past half its life, so the
 * window measures INACTIVITY instead. The tests below pin both halves: that an
 * old token is replaced, and that a fresh one is left alone.
 */

// The module reads JWT_SECRET once, at import time. Set it before pulling it in
// or every function under test short-circuits to null.
process.env.JWT_SECRET = "test-secret-for-sessions";
const SECRET = process.env.JWT_SECRET;

const { issueSessionToken, readSessionToken, renewSessionToken } = await import(
  "../src/auth/sessions.js"
);

const DAY = 24 * 60 * 60;
const ACCOUNT = "acct_12345";

/** A perfectly valid token that was simply issued `ageDays` ago. */
function tokenAgedDays(ageDays: number, accountId = ACCOUNT): string {
  const iat = Math.floor(Date.now() / 1000) - ageDays * DAY;
  // `expiresIn` counts from the payload's own `iat`, so this expires 30 days
  // after the backdated issue time rather than 30 days from now.
  return jwt.sign({ sub: accountId, iat }, SECRET, { expiresIn: 30 * DAY });
}

describe("session tokens", () => {
  test("a token round-trips to the account that owns it", () => {
    assert.equal(readSessionToken(issueSessionToken(ACCOUNT)), ACCOUNT);
  });

  test("nonsense is a guest, not an error", () => {
    assert.equal(readSessionToken("not-a-token"), null);
    assert.equal(readSessionToken(""), null);
  });

  test("a token signed with someone else's secret is refused", () => {
    const forged = jwt.sign({ sub: ACCOUNT }, "a-different-secret");
    assert.equal(readSessionToken(forged), null);
  });

  test("an expired token is refused", () => {
    assert.equal(readSessionToken(tokenAgedDays(31)), null);
  });
});

describe("sliding expiry", () => {
  test("a fresh token is left alone", () => {
    assert.equal(renewSessionToken(issueSessionToken(ACCOUNT)), null);
  });

  test("a token still inside the first half of its life is left alone", () => {
    // Renewing on every request would invalidate the copy any other open tab
    // is holding, so "not yet" is the correct answer here.
    assert.equal(renewSessionToken(tokenAgedDays(14)), null);
  });

  test("a token past half its life is replaced", () => {
    const renewed = renewSessionToken(tokenAgedDays(20));
    assert.ok(renewed, "expected a fresh token for a 20-day-old one");
    assert.equal(readSessionToken(renewed), ACCOUNT);
  });

  test("the replacement is itself fresh, so the window really slides", () => {
    // This is the whole point: each renewal buys another full window. Without
    // it, renewal would just re-issue something equally close to expiry.
    const renewed = renewSessionToken(tokenAgedDays(20));
    assert.ok(renewed);
    assert.equal(
      renewSessionToken(renewed),
      null,
      "a just-issued token should not immediately want renewing again",
    );
  });

  test("an already-expired token cannot be renewed", () => {
    // Otherwise the window would never close for anyone, and "signed out after
    // 30 days of absence" would stop meaning anything.
    assert.equal(renewSessionToken(tokenAgedDays(31)), null);
  });

  test("a forged token cannot be renewed", () => {
    const forged = jwt.sign({ sub: ACCOUNT }, "a-different-secret");
    assert.equal(renewSessionToken(forged), null);
  });
});

describe("renewal over the wire", () => {
  const PORT = "3210"; // unique across the suite - see portsUnique.test.ts
  const ORIGIN = "http://localhost:5173";
  let server: RunningServer;

  before(async () => {
    server = await startServer({
      NODE_ENV: "development",
      PORT,
      JWT_SECRET: SECRET,
    });
  });

  after(async () => {
    await server.stop();
  });

  /**
   * `/profile` with no database answers 503 — but the renewal happens in
   * `bearerAccountId`, which runs first. So the header is observable here
   * without standing up Postgres, because `setHeader` survives `writeHead`.
   */
  const getProfile = (token: string) =>
    fetch(`http://localhost:${PORT}/profile`, {
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
    });

  test("an old token comes back renewed in the response header", async () => {
    const res = await getProfile(tokenAgedDays(20));
    const renewed = res.headers.get("x-session-token");
    assert.ok(renewed, "expected X-Session-Token on the response");
    assert.equal(readSessionToken(renewed), ACCOUNT);
  });

  test("a fresh token gets no renewal header", async () => {
    const res = await getProfile(issueSessionToken(ACCOUNT));
    assert.equal(res.headers.get("x-session-token"), null);
  });

  test("the header is exposed to the browser", async () => {
    // ⚠️ WITHOUT THIS THE WHOLE MECHANISM IS INVISIBLE. A cross-origin response
    // hides every header the script did not explicitly ask for, so the client
    // would read null forever and the session would never actually slide.
    const res = await getProfile(tokenAgedDays(20));
    const exposed = res.headers.get("access-control-expose-headers") ?? "";
    assert.match(exposed, /X-Session-Token/i);
  });

  test("a rejected token is still a 401, renewal or not", async () => {
    const res = await getProfile("garbage");
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("x-session-token"), null);
  });
});
