import { eq, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { kingdomStats, profiles } from "./schema.js";
import { rewardsFor } from "../engine/rewards.js";
import { logger } from "../util/logger.js";
import { eligibilityFor, capped, ELIGIBILITY } from "../engine/eligibility.js";
import { addDailyTotals, getDailyTotals, grantCoins } from "./coins.js";
import { applyQuestProgress, type QuestPayout } from "./quests.js";
import { questDay } from "../engine/quests.js";
import type { MatchResult } from "../match/matchResult.js";

/**
 * Applying a finished match to everyone's progression.
 *
 * Runs after the match is recorded, and like that write it is bookkeeping: it
 * must never delay or affect a game. Failures are logged and swallowed.
 */

export interface AppliedReward {
  accountId: string;
  playerId: string;
  /** What was actually paid, after eligibility and the daily cap. */
  xp: number;
  coins: number;
  /** Present when the match paid nothing beyond participation. */
  ineligible?: "TOO_SHORT" | "INACTIVE";
  /** True when the private-room rate was applied. */
  reduced: boolean;
  /** Quests finished by this match. */
  quests: QuestPayout[];
}

/**
 * Credits XP and updates per-kingdom rollups for every signed-in human.
 *
 * ⚠️ ONLY SEATS WITH AN ACCOUNT EARN. Guests play the whole game and keep
 * nothing — that is the deal, and it is what keeps a guest's experience free of
 * any prompt to sign up mid-match.
 *
 * The full chain, in order: eligibility decides whether the match pays at all,
 * the private-room rate and the daily caps decide how much of it survives, and
 * quests are advanced for any match that counted. Kingdom rollups are RECORD
 * rather than reward — they count what happened even when the payout is
 * withheld, so an ineligible match still appears in your history and in the
 * balance data.
 */
export async function applyMatchProgression(
  result: MatchResult,
): Promise<AppliedReward[]> {
  const db = getDb();
  if (!db) return [];

  const rewards = rewardsFor(result).filter(
    (r): r is typeof r & { accountId: string } => r.accountId !== null,
  );
  if (rewards.length === 0) return [];

  const applied: AppliedReward[] = [];
  const day = questDay(new Date(result.endedAt));
  // A room code that was never listed publicly is a private room.
  const isPrivate = !result.isPublic;

  try {
    await db.transaction(async (tx) => {
      for (const reward of rewards) {
        const seat = result.participants.find((p) => p.playerId === reward.playerId);
        if (!seat) continue;

        const eligibility = eligibilityFor(seat, result, isPrivate);

        // ⚠️ QUESTS ONLY ADVANCE ON A MATCH THAT COUNTED. A quest advanced by
        // an instantly-conceded match would hand back exactly the farm the
        // duration gate exists to close.
        const quests = eligibility.earns
          ? await applyQuestProgress(tx, reward.accountId, seat, result, day)
          : [];

        // Eligibility decides whether the MATCH pays; the caps decide how much
        // of it survives. Both are applied to the figure the calculator
        // produced, never to the calculator itself.
        let xp = 0;
        let coins = 0;

        if (eligibility.earns) {
          const totals = await getDailyTotals(reward.accountId, day, tx);
          xp = capped(reward.xp * eligibility.rate, totals.xp, ELIGIBILITY.DAILY_XP_CAP);
          coins = capped(
            reward.coins * eligibility.rate,
            totals.coins,
            ELIGIBILITY.DAILY_COIN_CAP,
          );
        }

        if (xp > 0) {
          // Incremented in SQL rather than read-modify-write: two matches
          // ending at the same moment for one account would otherwise race,
          // and the second would overwrite the first with a stale total.
          await tx
            .update(profiles)
            .set({ xp: sql`${profiles.xp} + ${xp}`, updatedAt: new Date() })
            .where(eq(profiles.accountId, reward.accountId));
        }

        if (coins > 0) {
          // Keyed on the match, so a retried write cannot pay twice.
          await grantCoins(reward.accountId, coins, "match", result.matchId, tx);
        }

        if (xp > 0 || coins > 0) {
          await addDailyTotals(reward.accountId, day, coins, xp, false, tx);
        }

        // Kingdom rollups are RECORD, not reward: they count what happened,
        // so an ineligible match still shows up in your history and in the
        // balance data. Only the payout is withheld.
        if (seat.kingdomId) {
          const seconds = Math.round(seat.survivedTicks / Math.max(1, result.tickRate));
          const won = seat.placement === 1 ? 1 : 0;
          const top3 = seat.placement <= 3 ? 1 : 0;

          await tx
            .insert(kingdomStats)
            .values({
              accountId: reward.accountId,
              kingdomId: seat.kingdomId,
              matches: 1,
              wins: won,
              top3,
              playtimeSeconds: seconds,
              damageDealt: Math.round(seat.stats.damageDealt),
              placementSum: seat.placement,
            })
            .onConflictDoUpdate({
              target: [kingdomStats.accountId, kingdomStats.kingdomId],
              set: {
                matches: sql`${kingdomStats.matches} + 1`,
                wins: sql`${kingdomStats.wins} + ${won}`,
                top3: sql`${kingdomStats.top3} + ${top3}`,
                playtimeSeconds: sql`${kingdomStats.playtimeSeconds} + ${seconds}`,
                damageDealt: sql`${kingdomStats.damageDealt} + ${Math.round(seat.stats.damageDealt)}`,
                placementSum: sql`${kingdomStats.placementSum} + ${seat.placement}`,
                updatedAt: new Date(),
              },
            });
        }

        applied.push({
          accountId: reward.accountId,
          playerId: reward.playerId,
          xp,
          coins,
          ineligible: eligibility.reason,
          reduced: eligibility.rate < 1,
          quests,
        });
      }
    });

    logger.info("Progression applied", {
      matchId: result.matchId,
      accounts: applied.length,
    });
    return applied;
  } catch (error) {
    logger.warn("Could not apply progression", {
      matchId: result.matchId,
      message: (error as Error).message,
    });
    return [];
  }
}

export interface KingdomStatRow {
  kingdomId: string;
  matches: number;
  wins: number;
  top3: number;
  playtimeSeconds: number;
  damageDealt: number;
  placementSum: number;
}

/** Every kingdom this account has played, for the profile's table. */
export async function getKingdomStats(accountId: string): Promise<KingdomStatRow[]> {
  const db = getDb();
  if (!db) return [];
  try {
    return await db
      .select({
        kingdomId: kingdomStats.kingdomId,
        matches: kingdomStats.matches,
        wins: kingdomStats.wins,
        top3: kingdomStats.top3,
        playtimeSeconds: kingdomStats.playtimeSeconds,
        damageDealt: kingdomStats.damageDealt,
        placementSum: kingdomStats.placementSum,
      })
      .from(kingdomStats)
      .where(eq(kingdomStats.accountId, accountId));
  } catch (error) {
    logger.warn("Could not read kingdom stats", { message: (error as Error).message });
    return [];
  }
}
