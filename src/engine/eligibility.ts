import type { MatchParticipantResult, MatchResult } from "../match/matchResult.js";

/**
 * Whether a match pays at all.
 *
 * The moment coins exist, someone tries to manufacture them. The server already
 * decides everything about gameplay, so the attacks are economic rather than
 * technical: sit in a lobby doing nothing, concede instantly on repeat, or fill
 * the seats with bots and farm the win.
 *
 * These gates are deliberately quiet. A player who trips one is not accused of
 * anything and is not told — the reward is simply smaller or absent. Accusing
 * people of cheating for having a bad connection is worse than losing a payout.
 */

export const ELIGIBILITY = {
  /**
   * A match shorter than this pays participation only.
   *
   * Kills the fastest loop there is: open a private room, concede, repeat. Set
   * below any real game and above any farm.
   */
  MIN_SECONDS: 180,

  /**
   * The activity floor. Below EITHER of these, the seat did not play.
   *
   * Two conditions rather than one because they are dodged differently: a
   * script can spam a cheap ability, and an idle player can still accrue gold.
   * Having to do both is a much better filter than either alone.
   */
  MIN_ABILITIES_CAST: 3,
  MIN_GOLD_SPENT: 100,

  /**
   * What a PRIVATE room pays, as a fraction.
   *
   * Private rooms are the game's heart — a code read aloud to friends — so they
   * still pay. But they are also the only place a lobby can be curated, so they
   * pay less than matchmaking, where you do not choose your opponents.
   */
  PRIVATE_ROOM_RATE: 0.4,

  /**
   * The most a player can earn from matches in one day.
   *
   * Turns unlimited farming into bounded farming, which is the difference
   * between an exploit and a grind. Costs a normal player nothing: four-plus
   * hours of play.
   */
  DAILY_COIN_CAP: 2_500,
  DAILY_XP_CAP: 4_000,
} as const;

export type IneligibleReason = "TOO_SHORT" | "INACTIVE";

export interface Eligibility {
  /** Whether this seat earns beyond participation. */
  earns: boolean;
  reason?: IneligibleReason;
  /** Multiplier applied to the reward. 1 for a public match. */
  rate: number;
}

/**
 * Decides what one seat in one match is owed.
 *
 * ⚠️ NOTE WHAT THIS DOES NOT DO: it never rejects a QUEST. Quests are aimed at
 * while you play and count against bots by design; the gates here stop a match
 * paying, which is enough to stop a quest being farmed by conceding on repeat.
 */
export function eligibilityFor(
  seat: MatchParticipantResult,
  result: MatchResult,
  isPrivate: boolean,
): Eligibility {
  const rate = isPrivate ? ELIGIBILITY.PRIVATE_ROOM_RATE : 1;
  const seconds = result.durationTicks / Math.max(1, result.tickRate);

  if (seconds < ELIGIBILITY.MIN_SECONDS) {
    return { earns: false, reason: "TOO_SHORT", rate };
  }

  const played =
    seat.stats.abilitiesCast >= ELIGIBILITY.MIN_ABILITIES_CAST &&
    seat.stats.goldSpent >= ELIGIBILITY.MIN_GOLD_SPENT;

  if (!played) return { earns: false, reason: "INACTIVE", rate };

  return { earns: true, rate };
}

/**
 * Applies a daily cap to an amount.
 *
 * Returns what may actually be granted — zero once the cap is met. The caller
 * records the granted figure, so the cap is enforced against what was paid
 * rather than what was earned.
 */
export function capped(amount: number, alreadyToday: number, cap: number): number {
  const room = Math.max(0, cap - alreadyToday);
  return Math.min(Math.max(0, Math.round(amount)), room);
}
