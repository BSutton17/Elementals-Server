/**
 * Progression tunables: XP, levels, and kingdom mastery.
 *
 * Lives beside `balance.ts` and follows the same rule — data only, no logic.
 * The engine reads these; `engine/rewards.ts` turns them into an amount.
 *
 * ⚠️ NONE OF THIS TOUCHES GAMEPLAY. Levels unlock cosmetics and nothing else:
 * no kingdoms, no perks, no matchmaking weighting. Kingdoms is a party game
 * where a veteran and a first-timer sit on the same sofa, and any rule that
 * makes them play a different game breaks it.
 */

/** How XP is earned from a finished match. */
export const XP = {
  /**
   * For finishing at all, win or lose. Flat, and deliberately not scaled by
   * lobby size: this is payment for your own presence, not for an opponent.
   */
  PARTICIPATION: 60,

  /**
   * Per opponent OUTLASTED, before the placement multiplier.
   *
   * This is what makes a full lobby worth more than a duel without a separate
   * rule for it: in a seven-player game there are six kingdoms to outlast and
   * in a 1v1 there is one. Lobby size is therefore already in the number, and
   * anything that also scaled by player count would be counting it twice.
   */
  PER_OPPONENT_OUTLASTED: 22,

  /**
   * Placing higher pays exponentially, not linearly.
   *
   * The multiplier is `PLACEMENT_GROWTH ^ (opponents outlasted)`, so it
   * compounds with the count above rather than being added to it. In a
   * seven-player match that makes each step up the table worth more than the
   * last — the gap between 2nd and 1st is larger than the gap between 7th and
   * 6th, which is the shape "exponentially more for placing higher" describes.
   *
   * Kept modest (1.18) precisely BECAUSE it compounds: a larger base makes
   * first place worth so much more than second that the rest of the table
   * stops mattering.
   */
  PLACEMENT_GROWTH: 1.18,

  /**
   * What a BOT seat is worth relative to a human one, when you outlast it.
   *
   * A lobby padded with bots must not pay like a full house, or the cheapest
   * way to earn is to play nobody. Harder bots are worth more because beating
   * them is worth more.
   */
  BOT_WEIGHT: {
    easy: 0.05,
    medium: 0.1,
    hard: 0.25,
  } as Record<string, number>,

  /** A bot of unknown difficulty is worth the least. Fail cheap, not generous. */
  BOT_WEIGHT_DEFAULT: 0.05,
} as const;

/**
 * Coins use the SAME shape as XP — outlasting and the bot penalty both apply —
 * at a lower rate, so the two feel related without being identical.
 *
 * Phase 5 spends these; the calculator already produces them so the two can
 * never drift apart into two different notions of "how well did I do".
 */
export const COINS = {
  PARTICIPATION: 40,
  PER_OPPONENT_OUTLASTED: 15,
  /** Deliberately the same curve as XP: one performance, one shape. */
  PLACEMENT_GROWTH: XP.PLACEMENT_GROWTH,
} as const;

/** The level ladder. */
export const LEVELS = {
  /** XP for level 1 → 2. */
  BASE_COST: 800,
  /** Added to the cost of each subsequent level… */
  COST_STEP: 200,
  /** …until the cost stops growing, so the late game does not become a wall. */
  COST_CAP: 4_000,
  /** The top of the ladder. */
  MAX: 50,
} as const;

/**
 * Kingdom mastery: per kingdom, and earned by PLAYTIME rather than wins.
 *
 * Account level rewards breadth; mastery rewards devotion to one kingdom. Two
 * different players, two different ladders — and mastery is what gates a
 * kingdom's prestige skin, so it cannot be bought with coins alone.
 */
export const MASTERY = {
  TIERS: [
    { id: "bronze", name: "Bronze", hours: 2 },
    { id: "silver", name: "Silver", hours: 6 },
    { id: "gold", name: "Gold", hours: 15 },
    { id: "diamond", name: "Diamond", hours: 40 },
  ] as const,
} as const;

export type MasteryTierId = (typeof MASTERY.TIERS)[number]["id"];
