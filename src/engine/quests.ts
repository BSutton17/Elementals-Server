import {
  DAILY_RESET,
  QUESTS,
  QUESTS_PER_DAY,
  QUEST_TIERS,
  type QuestDefinition,
  type QuestTier,
} from "../data/quests.js";
import { KINGDOM_IDS } from "../data/kingdoms.js";
import { outlastScore } from "./rewards.js";
import type { MatchParticipantResult, MatchResult } from "../match/matchResult.js";

/**
 * Rolling and evaluating daily quests.
 *
 * Pure: no database, no clock beyond what is passed in. The day's three quests
 * are DERIVED from (account, day) rather than stored at roll time, so a player
 * who does not open the game still has the same three waiting, and a server
 * restart cannot lose or reroll them.
 */

// --- the daily boundary ------------------------------------------------------

/**
 * The quest day a given instant belongs to, as `YYYY-MM-DD`.
 *
 * Computed by shifting UTC by the reset offset and hour, so the boundary is a
 * single subtraction rather than local-time arithmetic on a server whose own
 * timezone is nobody's business.
 */
export function questDay(at: Date = new Date()): string {
  const shifted = new Date(
    at.getTime() + (DAILY_RESET.UTC_OFFSET_HOURS - DAILY_RESET.HOUR) * 3_600_000,
  );
  return shifted.toISOString().slice(0, 10);
}

/** When the current quest day ends, so the client can show a countdown. */
export function nextResetAt(at: Date = new Date()): Date {
  const day = questDay(at);
  const [y, m, d] = day.split("-").map(Number);
  // Midnight on the shifted day, converted back to real UTC, plus one day.
  const shiftedMidnight = Date.UTC(y!, m! - 1, d!);
  const realStart =
    shiftedMidnight - (DAILY_RESET.UTC_OFFSET_HOURS - DAILY_RESET.HOUR) * 3_600_000;
  return new Date(realStart + 86_400_000);
}

// --- rolling -----------------------------------------------------------------

/** A small deterministic hash, so the same seed always gives the same day. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Seeded generator — `mulberry32`, matching the engine's existing RNG. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RolledQuest {
  slot: number;
  questId: string;
  tier: QuestTier;
  /** Ready to display — placeholders already filled. */
  description: string;
  target: number;
  /** Set only for kingdom-scoped quests. */
  kingdomId: string | null;
  xp: number;
  coins: number;
}

const TIER_ORDER: QuestTier[] = ["easy", "medium", "hard"];

/**
 * The three quests for one account on one day.
 *
 * ⚠️ ONE OF EACH TIER, ALWAYS. Rolling three at random would regularly hand
 * someone three hard quests and someone else three easy ones, and a daily set
 * that is sometimes unreachable is worse than a predictable one.
 *
 * Deterministic in (accountId, day): same player, same day, same three — on
 * every device, across every restart, without needing to be written down first.
 */
export function rollDailyQuests(accountId: string, day: string): RolledQuest[] {
  const rolled: RolledQuest[] = [];

  for (let slot = 0; slot < QUESTS_PER_DAY; slot++) {
    const tier = TIER_ORDER[slot % TIER_ORDER.length]!;
    const pool = QUESTS.filter((q) => q.tier === tier);
    if (pool.length === 0) continue;

    // Slot is part of the seed so the three draws are independent.
    const next = rng(hash(`${accountId}:${day}:${slot}`));
    const quest = pool[Math.floor(next() * pool.length)]!;

    const kingdomId = quest.kingdomScoped
      ? KINGDOM_IDS[Math.floor(next() * KINGDOM_IDS.length)]!
      : null;

    rolled.push({
      slot,
      questId: quest.id,
      tier,
      description: describe(quest, kingdomId),
      target: quest.target,
      kingdomId,
      xp: QUEST_TIERS[tier].xp,
      coins: QUEST_TIERS[tier].coins,
    });
  }

  return rolled;
}

/** Fills `{target}` and `{kingdom}` for display. */
function describe(quest: QuestDefinition, kingdomId: string | null): string {
  return quest.template
    .replace("{target}", quest.target.toLocaleString("en-US"))
    .replace("{kingdom}", kingdomId ? capitalize(kingdomId) : "your kingdom");
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

// --- evaluating --------------------------------------------------------------

/** Whether a match counts toward a quest at all. */
function qualifies(
  quest: QuestDefinition,
  rolled: RolledQuest,
  seat: MatchParticipantResult,
  result: MatchResult,
): boolean {
  // Bots included on purpose: a quest you cannot attempt because nobody is
  // online is worse than one that is occasionally easy.
  if (quest.minPlayers && result.playerCount < quest.minPlayers) return false;
  if (quest.requiresWin && seat.placement !== 1) return false;
  if (rolled.kingdomId && seat.kingdomId !== rolled.kingdomId) return false;
  return true;
}

/** What one match contributes to one quest. */
export function contribution(
  quest: QuestDefinition,
  rolled: RolledQuest,
  seat: MatchParticipantResult,
  result: MatchResult,
): number {
  if (!qualifies(quest, rolled, seat, result)) return 0;

  switch (quest.metric) {
    case "wins":
      return seat.placement === 1 ? 1 : 0;
    case "matches":
      return 1;
    case "top3":
      return seat.placement <= 3 ? 1 : 0;
    case "damageDealt":
      return seat.stats.damageDealt;
    case "damageShielded":
      return seat.stats.damageShielded;
    case "goldSpent":
      return seat.stats.goldSpent;
    case "healingDone":
      return seat.stats.healingDone;
    case "abilitiesCast":
      return seat.stats.abilitiesCast;
    case "kills":
      return seat.stats.killsCredited;
    case "outlasted":
      return outlastScore(seat, result.participants);
    case "hpRemaining":
      return seat.hpRemaining;
    // Distinct-kingdom quests cannot be answered from one match alone — one
    // match is one kingdom. The caller tracks which have been seen; a match
    // contributes 1 only when its kingdom is new, which `advance` decides.
    case "distinctKingdomWins":
      return seat.placement === 1 ? 1 : 0;
    case "distinctKingdomsPlayed":
      return 1;
    default:
      return 0;
  }
}

/** Whether a metric counts distinct kingdoms rather than adding up. */
export function isDistinctMetric(quest: QuestDefinition): boolean {
  return (
    quest.metric === "distinctKingdomWins" || quest.metric === "distinctKingdomsPlayed"
  );
}

export interface QuestState {
  progress: number;
  /** Kingdoms already counted, for the distinct-kingdom quests. */
  seenKingdoms: string[];
  completed: boolean;
}

/**
 * Applies one match to one quest's state.
 *
 * Returns the new state, never mutating the old — this runs inside a database
 * transaction and has to be safe to discard.
 */
export function advance(
  quest: QuestDefinition,
  rolled: RolledQuest,
  state: QuestState,
  seat: MatchParticipantResult,
  result: MatchResult,
): QuestState {
  // Finished quests stop counting. Without this, progress would keep climbing
  // past the target and a later retune could "un-complete" somebody.
  if (state.completed) return state;

  const gained = contribution(quest, rolled, seat, result);
  if (gained <= 0) return state;

  let progress = state.progress;
  let seenKingdoms = state.seenKingdoms;

  if (isDistinctMetric(quest)) {
    const kingdom = seat.kingdomId;
    // A kingdom already counted adds nothing — that is what "different" means.
    if (!kingdom || seenKingdoms.includes(kingdom)) return state;
    seenKingdoms = [...seenKingdoms, kingdom];
    progress = seenKingdoms.length;
  } else if (quest.accumulate === "best") {
    // "In a single match": keep the highest, do not add them up.
    progress = Math.max(progress, gained);
  } else {
    progress = progress + gained;
  }

  return {
    progress,
    seenKingdoms,
    completed: progress >= quest.target,
  };
}

/** Looks a definition up by id. */
export function questById(id: string): QuestDefinition | undefined {
  return QUESTS.find((q) => q.id === id);
}
