import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET ?? "";

/**
 * 30 days of INACTIVITY, not 30 days total.
 *
 * ⚠️ THIS USED TO BE A FIXED WINDOW, which logged out someone who had played
 * every single day for a month — the opposite of what a party game wants.
 * `renewSessionToken` below re-issues a token once it is past half its life, so
 * anyone who opens the game inside any 30-day window stays signed in
 * indefinitely and only a genuinely absent player is asked to sign in again.
 */
const LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/**
 * Re-issue once a token is past half its life.
 *
 * Half rather than "on every request" for two reasons: a new token on every
 * response invalidates the copy any other open tab is holding, and re-signing a
 * JWT on every call is work we would be doing thousands of times to save a
 * player one sign-in a month.
 */
const RENEW_AFTER_SECONDS = LIFETIME_SECONDS / 2;

/** Creates our own signed token saying "this socket is this account". */
export function issueSessionToken(accountId: string): string {
  if (!SECRET) throw new Error("JWT_SECRET is not set");
  return jwt.sign({ sub: accountId }, SECRET, { expiresIn: LIFETIME_SECONDS });
}

/** Reads one back. Returns the account id, or null if it is bad or expired. */
export function readSessionToken(token: string): string | null {
  if (!SECRET) return null;
  try {
    const payload = jwt.verify(token, SECRET) as { sub?: string };
    return payload.sub ?? null;
  } catch {
    // Expired, tampered with, or signed with a different secret. All the same
    // answer: we do not know who this is. Not an error - just a guest.
    return null;
  }
}

/**
 * A fresh token to replace a still-valid one that is getting old, or null if it
 * does not need replacing yet.
 *
 * Callers hand the result back in the `X-Session-Token` response header and the
 * client stores it. That is the whole mechanism that turns the fixed expiry
 * above into a sliding one.
 */
export function renewSessionToken(token: string): string | null {
  if (!SECRET) return null;
  try {
    const payload = jwt.verify(token, SECRET) as { sub?: string; iat?: number };
    if (!payload.sub || typeof payload.iat !== "number") return null;
    const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
    if (ageSeconds < RENEW_AFTER_SECONDS) return null;
    return issueSessionToken(payload.sub);
  } catch {
    // Not valid in the first place, so there is nothing to renew.
    return null;
  }
}
