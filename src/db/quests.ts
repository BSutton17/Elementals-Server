import { and, eq } from "drizzle-orm";
import { getDb, type DbOrTx } from "./client.js";
import { dailyQuests } from "./schema.js";
import { advance, questById, questDay, rollDailyQuests, type RolledQuest } from "../engine/quests.js";
import { grantCoins } from "./coins.js";
import { logger } from "../util/logger.js";
import { profiles } from "./schema.js";
import { sql } from "drizzle-orm";
import type { MatchParticipantResult, MatchResult } from "../match/matchResult.js";

/**
 * Daily quest progress.
 *
 * The three quests themselves are derived, not stored — this only holds how far
 * along each one is, and whether it has paid out.
 */

export interface QuestView extends RolledQuest {
  progress: number;
  completed: boolean;
  rewarded: boolean;
}

/** The day's three quests with this account's progress against them. */
export async function getDailyQuests(
  accountId: string,
  day = questDay(),
): Promise<QuestView[]> {
  const rolled = rollDailyQuests(accountId, day);
  const db = getDb();
  if (!db) {
    // No database: show the quests, with nothing done. Better than an empty
    // panel that reads as "quests are broken".
    return rolled.map((r) => ({ ...r, progress: 0, completed: false, rewarded: false }));
  }

  try {
    const rows = await db
      .select()
      .from(dailyQuests)
      .where(and(eq(dailyQuests.accountId, accountId), eq(dailyQuests.day, day)));

    return rolled.map((r) => {
      const row = rows.find((x) => x.slot === r.slot);
      return {
        ...r,
        progress: Math.min(row?.progress ?? 0, r.target),
        completed: row?.completedAt != null,
        rewarded: row?.rewardedAt != null,
      };
    });
  } catch (error) {
    logger.warn("Quest read failed", { message: (error as Error).message });
    return rolled.map((r) => ({ ...r, progress: 0, completed: false, rewarded: false }));
  }
}

export interface QuestPayout {
  questId: string;
  description: string;
  xp: number;
  coins: number;
}

/**
 * Applies one finished match to this account's quests, paying out any that
 * complete.
 *
 * ⚠️ QUESTS ARE NOT SUBJECT TO THE DAILY CAP or the private-room rate. They are
 * a fixed, finite amount — three a day, once each — so there is nothing to farm
 * and no reason to scale them down. What they DO respect is match eligibility:
 * the caller only reaches here for a match that counted, so conceding on repeat
 * advances nothing.
 *
 * Runs inside the caller's transaction so quest progress, the payout, and the
 * match's own rewards all land together or not at all.
 */
export async function applyQuestProgress(
  tx: DbOrTx,
  accountId: string,
  seat: MatchParticipantResult,
  result: MatchResult,
  day = questDay(),
): Promise<QuestPayout[]> {
  const rolled = rollDailyQuests(accountId, day);
  const payouts: QuestPayout[] = [];

  const existing = await tx
    .select()
    .from(dailyQuests)
    .where(and(eq(dailyQuests.accountId, accountId), eq(dailyQuests.day, day)));

  for (const quest of rolled) {
    const definition = questById(quest.questId);
    if (!definition) continue;

    const row = existing.find((x) => x.slot === quest.slot);
    // Already paid: nothing left to do, and re-running must never pay again.
    if (row?.rewardedAt) continue;

    const before = {
      progress: row?.progress ?? 0,
      seenKingdoms: row?.seenKingdoms ?? [],
      completed: row?.completedAt != null,
    };

    const after = advance(definition, quest, before, seat, result);
    if (after === before) continue; // nothing qualified

    const justCompleted = after.completed && !before.completed;
    const now = new Date();

    await tx
      .insert(dailyQuests)
      .values({
        accountId,
        day,
        slot: quest.slot,
        questId: quest.questId,
        progress: after.progress,
        seenKingdoms: after.seenKingdoms,
        completedAt: after.completed ? now : null,
        rewardedAt: justCompleted ? now : null,
      })
      .onConflictDoUpdate({
        target: [dailyQuests.accountId, dailyQuests.day, dailyQuests.slot],
        set: {
          progress: after.progress,
          seenKingdoms: after.seenKingdoms,
          completedAt: after.completed ? now : null,
          rewardedAt: justCompleted ? now : row?.rewardedAt ?? null,
        },
      });

    if (!justCompleted) continue;

    // Pay both currencies. The coin side keys off the quest slot, so the
    // ledger's unique index makes a double payout impossible even if this ran
    // twice.
    await tx
      .update(profiles)
      .set({ xp: sql`${profiles.xp} + ${quest.xp}`, updatedAt: now })
      .where(eq(profiles.accountId, accountId));

    await grantCoins(accountId, quest.coins, "quest", `${day}:${quest.slot}`, tx);

    payouts.push({
      questId: quest.questId,
      description: quest.description,
      xp: quest.xp,
      coins: quest.coins,
    });
  }

  if (payouts.length > 0) {
    logger.info("Quests completed", { accountId, count: payouts.length });
  }
  return payouts;
}
