import { COINS, LEVELS, MASTERY, XP, type MasteryTierId } from "../data/progression.js";
import { param } from "./parameters.js";
import type { MatchParticipantResult, MatchResult } from "../match/matchResult.js";

/**
 * Turning a finished match into XP and coins.
 *
 * Pure: takes a result, returns numbers, touches nothing. That is deliberate —
 * this is the one place a player's reward is decided, and it has to be
 * inspectable and testable without a database, a socket, or a match.
 *
 * The model, in one line: **you are paid for who you outlasted, and paid more,
 * exponentially, the higher you finished.**
 */

export interface ParticipantReward {
  playerId: string;
  accountId: string | null;
  xp: number;
  coins: number;
  /** Weighted opponents outlasted — the figure both amounts are built from. */
  outlastScore: number;
}

/**
 * What one opponent is worth when you outlast them.
 *
 * A human is worth 1. A bot is worth a fraction of that, by difficulty, so a
 * lobby padded with bots cannot pay like a full house — otherwise the cheapest
 * way to earn would be to play nobody.
 */
export function opponentWeight(opponent: MatchParticipantResult): number {
  if (!opponent.isBot) return 1;
  const difficulty = opponent.botDifficulty ?? "";
  const weight = XP.BOT_WEIGHT[difficulty];
  return weight ?? XP.BOT_WEIGHT_DEFAULT;
}

/**
 * The weighted count of opponents this participant outlasted.
 *
 * "Outlasted" means finished ahead of: a strictly better placement. Players who
 * TIED — a draw's survivors, or two kingdoms eliminated on the same tick —
 * count for neither of them, because neither outlasted the other.
 */
export function outlastScore(
  participant: MatchParticipantResult,
  all: readonly MatchParticipantResult[],
): number {
  let score = 0;
  for (const other of all) {
    if (other.playerId === participant.playerId) continue;
    // Strictly worse placement = this participant finished ahead of them.
    if (other.placement > participant.placement) score += opponentWeight(other);
  }
  return score;
}

/**
 * The exponential placement bonus.
 *
 * Grows with the number of opponents outlasted, so it COMPOUNDS with the count
 * rather than being added to it. That is what makes each step up the table
 * worth more than the last: in a seven-player match the jump from 2nd to 1st
 * pays far more than the jump from 7th to 6th.
 */
function placementMultiplier(score: number, growth: number): number {
  return Math.pow(growth, Math.max(0, score));
}

/** XP for one participant. Bots earn nothing — there is nobody to pay. */
export function xpFor(
  participant: MatchParticipantResult,
  all: readonly MatchParticipantResult[],
): number {
  if (participant.isBot) return 0;
  const score = outlastScore(participant, all);
  const perOpponent = param("xp.perOpponentOutlasted", XP.PER_OPPONENT_OUTLASTED);
  const growth = param("xp.placementGrowth", XP.PLACEMENT_GROWTH);
  const participation = param("xp.participation", XP.PARTICIPATION);
  return Math.round(
    participation + score * perOpponent * placementMultiplier(score, growth),
  );
}

/** Coins for one participant. Same shape as XP, lower rate. */
export function coinsFor(
  participant: MatchParticipantResult,
  all: readonly MatchParticipantResult[],
): number {
  if (participant.isBot) return 0;
  const score = outlastScore(participant, all);
  const perOpponent = param("coins.perOpponentOutlasted", COINS.PER_OPPONENT_OUTLASTED);
  const growth = param("coins.placementGrowth", COINS.PLACEMENT_GROWTH);
  const participation = param("coins.participation", COINS.PARTICIPATION);
  return Math.round(
    participation + score * perOpponent * placementMultiplier(score, growth),
  );
}

/** Rewards for every human in a finished match. */
export function rewardsFor(result: MatchResult): ParticipantReward[] {
  return result.participants
    .filter((p) => !p.isBot)
    .map((p) => ({
      playerId: p.playerId,
      accountId: p.accountId,
      xp: xpFor(p, result.participants),
      coins: coinsFor(p, result.participants),
      outlastScore: outlastScore(p, result.participants),
    }));
}

// --- the level ladder --------------------------------------------------------

/** XP required to go from `level` to `level + 1`. */
export function xpForNextLevel(level: number): number {
  if (level >= LEVELS.MAX) return Infinity; // Nothing above the cap to buy.
  const cost = LEVELS.BASE_COST + LEVELS.COST_STEP * Math.max(0, level - 1);
  return Math.min(cost, LEVELS.COST_CAP);
}

export interface LevelProgress {
  level: number;
  /** XP accumulated toward the NEXT level, not lifetime. */
  xpIntoLevel: number;
  /** XP the next level costs, or 0 at the cap. */
  xpForNext: number;
}

/**
 * Resolves lifetime XP into a level and progress toward the next one.
 *
 * Derived rather than stored, so the ladder can be retuned without migrating
 * anybody: change the curve and every player's level recomputes from the same
 * lifetime total. Storing the level instead would freeze today's curve into
 * every row.
 */
export function levelFromXp(totalXp: number): LevelProgress {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));

  while (level < LEVELS.MAX) {
    const cost = xpForNextLevel(level);
    if (remaining < cost) break;
    remaining -= cost;
    level += 1;
  }

  return {
    level,
    xpIntoLevel: level >= LEVELS.MAX ? 0 : remaining,
    xpForNext: level >= LEVELS.MAX ? 0 : xpForNextLevel(level),
  };
}

// --- kingdom mastery ---------------------------------------------------------

export interface MasteryProgress {
  tier: MasteryTierId | null;
  name: string | null;
  /** Seconds until the next tier, or null once the top is reached. */
  secondsToNext: number | null;
  nextName: string | null;
}

/** Mastery for one kingdom, from time played with it. */
export function masteryFor(playtimeSeconds: number): MasteryProgress {
  const hours = Math.max(0, playtimeSeconds) / 3600;
  let current: (typeof MASTERY.TIERS)[number] | null = null;
  let next: (typeof MASTERY.TIERS)[number] | null = null;

  for (const tier of MASTERY.TIERS) {
    if (hours >= tier.hours) current = tier;
    else {
      next = tier;
      break;
    }
  }

  return {
    tier: current?.id ?? null,
    name: current?.name ?? null,
    secondsToNext: next ? Math.round((next.hours - hours) * 3600) : null,
    nextName: next?.name ?? null,
  };
}
