/**
 * Username rules.
 *
 * A username is not the same thing as the in-match display name that
 * `lobbyHandlers.normalizeName` accepts. That one is typed fresh each session,
 * belongs to one match, and can be anything. A username is PERMANENT, UNIQUE,
 * and shown to strangers in public lobbies — so it is held to stricter rules,
 * and this module is the single place they live.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16;

/**
 * Letters, digits, underscore and hyphen. Deliberately NO SPACES.
 *
 * Spaces are the cheapest impersonation tool there is: "Bryson" and "Bryson "
 * are different rows to the database and the same name to every human being
 * reading a lobby. Banning them outright is simpler than trying to normalise
 * every kind of whitespace, of which Unicode has many.
 */
const ALLOWED = /^[A-Za-z0-9_-]+$/;

/** Must start and end with a letter or digit — no "__bryson__". */
const EDGES = /^[A-Za-z0-9].*[A-Za-z0-9]$|^[A-Za-z0-9]$/;

/**
 * Names nobody may take, because taking one lets you lie about who you are.
 * Compared case-insensitively against the whole username, not as a substring:
 * banning "admin" as a substring would also ban "admiral".
 */
const RESERVED = new Set([
  "admin",
  "administrator",
  "moderator",
  "mod",
  "staff",
  "support",
  "system",
  "server",
  "kingdoms",
  "official",
  "null",
  "undefined",
  "you",
  "bot",
  "deleted",
  "anonymous",
  "guest",
  "player",
]);

/**
 * A deliberately small, obvious profanity list.
 *
 * ⚠️ THIS IS NOT A CONTENT MODERATION SYSTEM and should not be mistaken for
 * one. It catches the laziest attempts so the first public lobby is not
 * immediately unpleasant. Real moderation is a report button and a human,
 * which is a later phase — filters alone have never worked, and an aggressive
 * one mostly blocks people whose real names it does not like.
 *
 * Matched against the whole username with separators stripped, so "f_u_c_k"
 * does not sail past.
 */
const PROFANITY = [
  "fuck",
  "shit",
  "cunt",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "rape",
  "nazi",
  "hitler",
];

export type UsernameError =
  | "TOO_SHORT"
  | "TOO_LONG"
  | "INVALID_CHARACTERS"
  | "BAD_EDGES"
  | "RESERVED"
  | "PROFANITY";

export interface UsernameCheck {
  ok: boolean;
  error?: UsernameError;
  /** A sentence to show the player. Errors should teach, not just refuse. */
  message?: string;
  /** The trimmed username to store, present only when ok. */
  username?: string;
}

const MESSAGES: Record<UsernameError, string> = {
  TOO_SHORT: `Usernames need at least ${USERNAME_MIN} characters.`,
  TOO_LONG: `Usernames can be at most ${USERNAME_MAX} characters.`,
  INVALID_CHARACTERS: "Use letters, numbers, underscores and hyphens only — no spaces.",
  BAD_EDGES: "Start and end with a letter or number.",
  RESERVED: "That name is reserved. Pick another.",
  PROFANITY: "Pick a different name.",
};

const fail = (error: UsernameError): UsernameCheck => ({
  ok: false,
  error,
  message: MESSAGES[error],
});

/**
 * Validates a candidate username. Does NOT check uniqueness — that needs the
 * database and lives in `db/accounts.setUsername`, where it can be resolved in
 * the same transaction that writes the row.
 */
export function checkUsername(raw: unknown): UsernameCheck {
  if (typeof raw !== "string") return fail("INVALID_CHARACTERS");
  const username = raw.trim();

  if (username.length < USERNAME_MIN) return fail("TOO_SHORT");
  if (username.length > USERNAME_MAX) return fail("TOO_LONG");
  if (!ALLOWED.test(username)) return fail("INVALID_CHARACTERS");
  if (!EDGES.test(username)) return fail("BAD_EDGES");

  const lower = username.toLowerCase();
  if (RESERVED.has(lower)) return fail("RESERVED");

  // Strip separators so spaced-out spellings are caught too.
  const collapsed = lower.replace(/[_-]/g, "");
  if (PROFANITY.some((word) => collapsed.includes(word))) return fail("PROFANITY");

  return { ok: true, username };
}

/** The case-insensitive key a username is made unique on. */
export function usernameKey(username: string): string {
  return username.toLowerCase();
}
