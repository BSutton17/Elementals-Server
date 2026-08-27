import { getDb } from "./client.js";
import { matches, participants } from "./schema.js";
import { logger } from "../util/logger.js";
import type { MatchResult } from "../match/matchResult.js";
import { applyMatchProgression } from "./progression.js";

/**
 * Writing finished matches to the database.
 *
 * ⚠️ RECORDING A MATCH MUST NEVER AFFECT THE MATCH. By the time this runs the
 * game is over and the players have their result on screen; the write is
 * bookkeeping that happens afterwards. A slow database, an unreachable one, or
 * none at all costs a row of history — never a game, never a delayed screen.
 *
 * That is why `recordMatchResult` resolves to a boolean instead of throwing,
 * and why the only caller fires it without awaiting.
 */

/** Whole numbers only: these are counters, and the schema stores integers. */
const whole = (value: number): number => Math.max(0, Math.round(value || 0));

/**
 * Persists a finished match and everyone in it.
 *
 * Both tables are written in one transaction, so a match never exists with a
 * partial set of players — a half-recorded match would skew a win rate more
 * quietly than a missing one.
 *
 * Idempotent: the match id is generated once when the result is built, so
 * recording the same result twice inserts nothing the second time.
 *
 * Returns true if the rows landed, false for every kind of "not today" —
 * including having no database at all.
 */
export async function recordMatchResult(result: MatchResult): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  try {
    let alreadyRecorded = false;
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(matches)
        .values({
          id: result.matchId,
          roomCode: result.roomCode,
          endedAt: new Date(result.endedAt),
          durationTicks: whole(result.durationTicks),
          tickRate: whole(result.tickRate),
          playerCount: result.playerCount,
          humanCount: result.humanCount,
          winnerPlayerId: result.winnerId,
          balanceVersion: result.balanceVersion,
        })
        .onConflictDoNothing()
        .returning({ id: matches.id });

      // Already recorded. Returning here rather than inserting the participants
      // again is the whole of the idempotency guarantee.
      if (inserted.length === 0) {
        alreadyRecorded = true;
        return;
      }

      await tx.insert(participants).values(
        result.participants.map((p) => ({
          matchId: result.matchId,
          // A guest or a bot has no account; the row still counts for balance.
          accountId: p.accountId,
          playerId: p.playerId,
          name: p.name,
          kingdomId: p.kingdomId,
          placement: p.placement,
          isBot: p.isBot,
          botDifficulty: p.botDifficulty,
          eliminatedAtTick: p.eliminatedAtTick,
          survivedTicks: whole(p.survivedTicks),
          damageDealt: whole(p.stats.damageDealt),
          damageTaken: whole(p.stats.damageTaken),
          healingDone: whole(p.stats.healingDone),
          goldEarned: whole(p.stats.goldEarned),
          goldSpent: whole(p.stats.goldSpent),
          abilitiesCast: whole(p.stats.abilitiesCast),
          killsCredited: whole(p.stats.killsCredited),
        })),
      );
    });

    // Say which of the two happened. A log line that reads "recorded" when
    // nothing was written is how a duplicate-write bug stays invisible.
    if (alreadyRecorded) {
      logger.debug("Match already recorded, skipped", { matchId: result.matchId });
    } else {
      logger.info("Match recorded", {
        matchId: result.matchId,
        roomCode: result.roomCode,
        players: result.playerCount,
        humans: result.humanCount,
      });
    }
    // ⚠️ ONLY AFTER A SUCCESSFUL, NON-DUPLICATE INSERT. Progression outside this
    // guard would pay a player twice for the same match every time the write
    // was retried - the exact bug the idempotent insert above exists to stop.
    if (!alreadyRecorded) await applyMatchProgression(result);

    return true;
  } catch (error) {
    // Logged at warn, not error: a lost history row is not an incident, and
    // paging on it would train everyone to ignore the log.
    logger.warn("Could not record match", {
      matchId: result.matchId,
      message: (error as Error).message,
    });
    return false;
  }
}
