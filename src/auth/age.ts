/**
 * The age gate.
 *
 * Elementals is a party game with cartoon castles, so children will play it.
 * The moment an account stores an email address and tracks behaviour against
 * it, that combination is governed by law written specifically about it —
 * COPPA in the US, the GDPR's digital-consent age in the EU, and the UK's Age
 * Appropriate Design Code.
 *
 * Complying properly for under-13s means verifiable parental consent: a parent
 * to contact, consent records, and a parent-facing deletion path. That is
 * disproportionate here, so the answer is simpler and stricter — **no accounts
 * under 13**. Under-13s play as guests, which stores nothing about them, so
 * almost none of the above applies.
 */

/** The youngest age that may hold an account. */
export const MINIMUM_ACCOUNT_AGE = 13;

/**
 * Age buckets. These, not a date of birth, are what gets stored.
 *
 * A birth date is a strong identifier that would be useful to nobody here and
 * damaging in a leak. The bracket answers every question a rule actually asks.
 */
export type AgeBracket = "13-15" | "16-17" | "18+";

export type AgeError = "TOO_YOUNG" | "INVALID_DATE";

export interface AgeCheck {
  ok: boolean;
  error?: AgeError;
  message?: string;
  bracket?: AgeBracket;
}

/** Whole years between a birth date and now, in UTC. */
export function ageFrom(birth: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const month = now.getUTCMonth() - birth.getUTCMonth();
  // Birthday has not happened yet this year.
  if (month < 0 || (month === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

function bracketFor(age: number): AgeBracket {
  if (age >= 18) return "18+";
  if (age >= 16) return "16-17";
  return "13-15";
}

/**
 * Checks a submitted date of birth.
 *
 * ⚠️ THE GATE MUST BE NEUTRAL. It asks for a date, not "are you over 13?" — a
 * yes/no question teaches a child which answer gets them in, and is worth
 * nothing as a control. Asking for a date is the accepted approach and is what
 * the regulators describe.
 *
 * Returns the BRACKET, never the date. The caller stores the bracket.
 */
export function checkAge(raw: unknown, now = new Date()): AgeCheck {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "INVALID_DATE", message: "Enter your date of birth." };
  }

  const birth = new Date(`${raw.trim()}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) {
    return { ok: false, error: "INVALID_DATE", message: "That is not a valid date." };
  }

  if (birth.getTime() > now.getTime()) {
    return { ok: false, error: "INVALID_DATE", message: "That date is in the future." };
  }

  const age = ageFrom(birth, now);
  // A plausibility bound, not an age limit: 130+ is a typo, not a player.
  if (age > 130) {
    return { ok: false, error: "INVALID_DATE", message: "That is not a valid date." };
  }

  if (age < MINIMUM_ACCOUNT_AGE) {
    return {
      ok: false,
      error: "TOO_YOUNG",
      // Says what they CAN do. Being turned away from a game with no
      // explanation is worse than being told the rule and the alternative.
      message: `You need to be ${MINIMUM_ACCOUNT_AGE} to have an account. You can still play — everything in the game is available without one.`,
    };
  }

  return { ok: true, bracket: bracketFor(age) };
}
