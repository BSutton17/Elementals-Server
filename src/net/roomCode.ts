import { LOBBY } from "../data/balance.js";

/** Safety bound so an exhausted/near-full code space fails loudly, not forever. */
const MAX_ATTEMPTS = 1000;

/**
 * Generates a unique numeric room code (zero-padded to `LOBBY.ROOM_CODE_LENGTH`
 * digits, e.g. "0042"–"9999") for a new match.
 *
 * Uniqueness is delegated to the caller via `isTaken`, so this stays decoupled
 * from how active matches are stored: pass `(code) => activeMatches.has(code)`.
 * Retries until it finds a free code, throwing if it cannot within a bounded
 * number of attempts (i.e. the code space is effectively full).
 *
 * Uses `Math.random` — room codes are not security-sensitive and are not part of
 * the deterministic game simulation.
 */
export function generateRoomCode(
  isTaken: (code: string) => boolean = () => false,
): string {
  const length = LOBBY.ROOM_CODE_LENGTH;
  const upperBound = 10 ** length; // exclusive: 0 .. 10^length - 1

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = String(Math.floor(Math.random() * upperBound)).padStart(
      length,
      "0",
    );
    if (!isTaken(code)) return code;
  }

  throw new Error(
    `Unable to generate a unique ${length}-digit room code after ${MAX_ATTEMPTS} attempts`,
  );
}
