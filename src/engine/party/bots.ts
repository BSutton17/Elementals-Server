import { TICK } from "../../data/balance.js";
import type { Match } from "../../match/Match.js";
import type { BotDifficulty } from "../../match/types.js";

/**
 * How bots play party games.
 *
 * ⚠️ NO NETWORK, NO MODEL, NO POLICY — DICE AND DELAYS. The trained AI drives
 * the war: what to buy, who to attack, when to cast. It has never seen a maze,
 * a lock or a blackjack hand, and teaching it nine minigames would be an
 * enormous amount of work to make a bot that clicks a green button. What a
 * party game actually needs from a bot is that it behaves like a PLAYER of a
 * known standard — sometimes fast, sometimes wrong — and that is a random roll
 * against a difficulty and a plausible delay.
 *
 * ⚠️ AND THE NUMBERS ARE HERE, NOT SPRINKLED THROUGH NINE FILES. Every game
 * asks this module the same two questions — "does this bot get it right?" and
 * "how long does it take?" — so tuning bot standard is one file, and a game
 * that forgets to consider difficulty is obvious by not calling in.
 */

/** Hard is the default: an unlabelled seat is a full-strength opponent. */
export function botDifficulty(match: Match, playerId: string): BotDifficulty {
  return match.getPlayers().find((p) => p.id === playerId)?.botDifficulty ?? "hard";
}

/**
 * How often a bot of this standard gets a minigame right.
 *
 * One table for every skill game — the maze, the memory sequence, spotting the
 * difference, the sum. A bot that is good at mazes and hopeless at arithmetic
 * would be a strange kind of opponent, and three numbers are easier to tune
 * than twenty-seven.
 */
export function successChance(difficulty: BotDifficulty): number {
  if (difficulty === "easy") return 0.5;
  if (difficulty === "medium") return 0.75;
  return 0.9;
}

/** A uniform roll inside an inclusive range. */
export function between(rng: () => number, low: number, high: number): number {
  return low + rng() * (high - low);
}

/** The same, converted to whole ticks — what every scheduling decision wants. */
export function ticksBetween(
  rng: () => number,
  lowSeconds: number,
  highSeconds: number,
): number {
  return Math.max(1, Math.round(between(rng, lowSeconds, highSeconds) * TICK.RATE));
}

/** Milliseconds, for the reaction-speed numbers, which are quoted that way. */
export function ticksBetweenMs(rng: () => number, lowMs: number, highMs: number): number {
  return Math.max(1, Math.round((between(rng, lowMs, highMs) / 1000) * TICK.RATE));
}

/**
 * How long a bot takes to react once the light turns green.
 *
 * ⚠️ SLOWER THAN A RAW REFLEX, ON PURPOSE. A bot's "reaction" is a scheduled
 * tick: it has no eyes to move, no cursor to travel and no button to find, so
 * timing it at a human's raw reflex speed made it faster than any person could
 * ever be — and this game punishes whoever is LAST. These numbers carry an
 * extra 150ms at every level to stand in for the part of reacting that is not
 * reflex, which is most of it.
 */
export const REACTION_MS: Record<BotDifficulty, [number, number]> = {
  easy: [450, 550],
  medium: [400, 450],
  hard: [370, 400],
};

/**
 * How long a bot sits on the bomb before throwing it at somebody.
 *
 * ⚠️ THE TOP OF EACH BAND IS WIDE ON PURPOSE. A narrow band makes every bot
 * pass at almost exactly the same beat, and the bomb turns into a metronome
 * going round the table — the same kingdoms hold it for the same time and the
 * loser is decided by seating. A hundred milliseconds of spread at the top is
 * enough for the hold times to actually diverge.
 */
export const BOMB_PASS_MS: Record<BotDifficulty, [number, number]> = {
  easy: [400, 600],
  medium: [350, 500],
  hard: [320, 450],
};

/** Clicks per second in Button Mash. A hard bot is a fast human, not a script. */
export const MASH_CPS: Record<BotDifficulty, [number, number]> = {
  easy: [4, 7],
  medium: [6, 10],
  hard: [8, 12],
};

/**
 * How often a bot re-attempts a game it can keep trying at.
 *
 * Spot the Difference and Quick Math are not pass/fail on one roll — a player
 * keeps looking, keeps trying — so a bot rolls its success chance on this
 * cadence until it gets there. The two intervals differ because the games do:
 * scanning two castles is quicker than doing arithmetic under pressure.
 */
export const RETRY_SECONDS: Record<"spot" | "math", [number, number]> = {
  spot: [4.21, 6.2],
  math: [4.71, 6.33],
};
