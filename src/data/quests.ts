/**
 * Daily quests.
 *
 * Three a day, one of each difficulty, refreshed at the same boundary the shop
 * uses. Each pays BOTH xp and coins, and harder ones pay more.
 *
 * ⚠️ QUESTS COUNT AGAINST BOTS. Unlike the per-match reward — where a bot seat
 * is worth a fraction of a human one — a quest does not care who was in the
 * lobby. That is deliberate: a quest is something to aim at while you play,
 * and one you cannot attempt because nobody else is online is worse than one
 * that is occasionally easy. The activity floor and minimum duration in
 * `engine/eligibility.ts` still apply, so a quest cannot be farmed by
 * instantly conceding.
 *
 * Data only. `engine/quests.ts` evaluates these against a match result.
 */

/** Harder tiers pay more, in both currencies. */
export const QUEST_TIERS = {
  easy: { xp: 120, coins: 80 },
  medium: { xp: 260, coins: 170 },
  hard: { xp: 500, coins: 320 },
} as const;

export type QuestTier = keyof typeof QUEST_TIERS;

/**
 * What a match contributes toward a quest.
 *
 * `sum` adds every qualifying match together; `best` keeps the highest single
 * match, which is what "in a single match" means.
 */
export type QuestAccumulation = "sum" | "best";

/** The figure a quest reads out of one match. */
export type QuestMetric =
  | "wins"
  | "matches"
  | "damageDealt"
  | "damageShielded"
  | "goldSpent"
  | "healingDone"
  | "abilitiesCast"
  | "kills"
  | "outlasted"
  | "top3"
  | "hpRemaining"
  /** Counts DISTINCT kingdoms, so repeating one does not advance it. */
  | "distinctKingdomWins"
  | "distinctKingdomsPlayed";

export interface QuestDefinition {
  id: string;
  tier: QuestTier;
  /** `{target}` and `{kingdom}` are filled when the quest is rolled. */
  template: string;
  metric: QuestMetric;
  accumulate: QuestAccumulation;
  /** How much of the metric completes it. */
  target: number;
  /** Only matches with at least this many seats count. Bots included. */
  minPlayers?: number;
  /** Only winning matches count. */
  requiresWin?: boolean;
  /** Rolls a kingdom for the day and only counts matches played as it. */
  kingdomScoped?: boolean;
}

/**
 * The catalogue.
 *
 * Tiers are assigned by how much a quest actually asks of a player, not by how
 * big its number looks: "win three times as one specific kingdom" is hard
 * because it needs three wins AND the roll to go your way, while "deal 40,000
 * damage" is a few matches of ordinary play.
 */
export const QUESTS: QuestDefinition[] = [
  // --- kingdom-scoped wins (the roll picks the kingdom) ---------------------
  {
    id: "winAsKingdom1",
    tier: "easy",
    template: "Win a game as {kingdom} in a 4+ player lobby",
    metric: "wins",
    accumulate: "sum",
    target: 1,
    minPlayers: 4,
    requiresWin: true,
    kingdomScoped: true,
  },
  {
    id: "winAsKingdom2",
    tier: "medium",
    template: "Win 2 games as {kingdom} in a 4+ player lobby",
    metric: "wins",
    accumulate: "sum",
    target: 2,
    minPlayers: 4,
    requiresWin: true,
    kingdomScoped: true,
  },
  {
    id: "winAsKingdom3",
    tier: "hard",
    template: "Win 3 games as {kingdom} in a 4+ player lobby",
    metric: "wins",
    accumulate: "sum",
    target: 3,
    minPlayers: 4,
    requiresWin: true,
    kingdomScoped: true,
  },
  {
    id: "winThreeKingdoms",
    tier: "hard",
    template: "Win with 3 different kingdoms in 4+ player lobbies",
    metric: "distinctKingdomWins",
    accumulate: "sum",
    target: 3,
    minPlayers: 4,
    requiresWin: true,
  },

  // --- cumulative output ----------------------------------------------------
  {
    id: "dealDamage",
    tier: "easy",
    template: "Deal {target} damage",
    metric: "damageDealt",
    accumulate: "sum",
    target: 40_000,
  },
  {
    id: "shieldDamage",
    tier: "medium",
    template: "Absorb {target} damage with shields",
    metric: "damageShielded",
    accumulate: "sum",
    target: 6_000,
  },
  {
    id: "spendGold",
    tier: "easy",
    template: "Spend {target} gold",
    metric: "goldSpent",
    accumulate: "sum",
    target: 8_000,
  },

  // --- single-match feats ---------------------------------------------------
  {
    id: "dealDamageSingle",
    tier: "medium",
    template: "Deal {target} damage in a single match",
    metric: "damageDealt",
    accumulate: "best",
    target: 18_000,
  },
  {
    id: "shieldDamageSingle",
    tier: "hard",
    template: "Absorb {target} damage with shields in a single match",
    metric: "damageShielded",
    accumulate: "best",
    target: 5_000,
  },
  {
    id: "spendGoldSingle",
    tier: "medium",
    template: "Spend {target} gold in a single match",
    metric: "goldSpent",
    accumulate: "best",
    target: 4_000,
  },
  {
    id: "winHealthy",
    tier: "hard",
    template: "Win with at least {target} health remaining",
    metric: "hpRemaining",
    accumulate: "best",
    target: 6_000,
    requiresWin: true,
  },

  // --- five of my own, chosen to reward the play the list above misses -------
  {
    // Rewards placing well in BIG lobbies without demanding wins — the honest
    // measure of doing well in a seven-way free-for-all.
    id: "outlastKingdoms",
    tier: "medium",
    template: "Outlast {target} kingdoms",
    metric: "outlasted",
    accumulate: "sum",
    target: 12,
  },
  {
    // Consistency rather than victory. A player who never quite wins still has
    // something to finish.
    id: "topThree",
    tier: "easy",
    template: "Finish top 3 in {target} matches",
    metric: "top3",
    accumulate: "sum",
    target: 3,
    minPlayers: 4,
  },
  {
    // The roster is the game's long-term hook; nothing else pushes breadth.
    id: "playDifferentKingdoms",
    tier: "easy",
    template: "Play {target} different kingdoms",
    metric: "distinctKingdomsPlayed",
    accumulate: "sum",
    target: 3,
  },
  {
    // Aggression, and the only quest that reads the killing blow.
    id: "eliminate",
    tier: "medium",
    template: "Eliminate {target} kingdoms",
    metric: "kills",
    accumulate: "sum",
    target: 5,
  },
  {
    // Gives the healing kingdoms — Water, Love — something of their own to aim
    // at, since every other quest here rewards damage or gold.
    id: "healHealth",
    tier: "medium",
    template: "Restore {target} health",
    metric: "healingDone",
    accumulate: "sum",
    target: 5_000,
  },
];

/** Quests per day. One of each tier — see `rollDailyQuests`. */
export const QUESTS_PER_DAY = 3;

/**
 * The daily boundary, as an offset from UTC in hours.
 *
 * 10:00 America/Chicago. Stored as an offset rather than a timezone name so the
 * refresh is computed in UTC and cannot drift; ⚠️ this means it is 10:00 CDT in
 * summer and 09:00 CST in winter. Pinning the CLOCK across a daylight-saving
 * shift would require a real timezone database, and a shop that refreshes an
 * hour earlier for half the year is a smaller problem than one that refreshes
 * twice on the day the clocks change.
 */
export const DAILY_RESET = {
  /** CDT is UTC-5. */
  UTC_OFFSET_HOURS: -5,
  /** Local hour the day flips. */
  HOUR: 10,
} as const;
