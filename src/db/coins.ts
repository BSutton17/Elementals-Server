import { and, eq, sql } from "drizzle-orm";
import { getDb, type DbOrTx } from "./client.js";
import { coinLedger, dailyEarnings } from "./schema.js";
import { logger } from "../util/logger.js";

/**
 * The coin ledger.
 *
 * A balance is `SUM(delta)`, never a stored number. Every grant carries an
 * idempotency key built from its cause, so paying twice is impossible rather
 * than merely unlikely.
 */

export type CoinReason = "match" | "quest" | "purchase" | "adjustment";

/** Anything with the same key is the same grant, however often it is tried. */
export function idempotencyKey(
  reason: CoinReason,
  accountId: string,
  refId: string,
): string {
  return `${reason}:${refId}:${accountId}`;
}

/**
 * Appends one entry.
 *
 * Returns true if it landed, false if this exact grant was already recorded —
 * which is a success, not a failure: the player has the coins either way.
 *
 * Takes an optional transaction so a grant can be written atomically alongside
 * whatever caused it (a purchase must not deduct without also handing over the
 * item).
 */
export async function grantCoins(
  accountId: string,
  delta: number,
  reason: CoinReason,
  refId: string,
  tx?: DbOrTx,
): Promise<boolean> {
  const db = tx ?? getDb();
  if (!db) return false;
  if (delta === 0) return true;

  try {
    const written = await db
      .insert(coinLedger)
      .values({
        accountId,
        delta: Math.round(delta),
        reason,
        refId,
        idempotencyKey: idempotencyKey(reason, accountId, refId),
      })
      .onConflictDoNothing()
      .returning({ id: coinLedger.id });

    return written.length > 0;
  } catch (error) {
    logger.warn("Coin grant failed", {
      accountId,
      reason,
      message: (error as Error).message,
    });
    return false;
  }
}

/** The current balance: the sum of every entry, computed in the database. */
export async function getBalance(accountId: string): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  try {
    const rows = await db
      .select({ balance: sql<number>`coalesce(sum(${coinLedger.delta}), 0)::int` })
      .from(coinLedger)
      .where(eq(coinLedger.accountId, accountId));
    return rows[0]?.balance ?? 0;
  } catch (error) {
    logger.warn("Balance read failed", { message: (error as Error).message });
    return 0;
  }
}

export interface DailyTotals {
  coins: number;
  xp: number;
  firstWinClaimed: boolean;
}

/** What this account has already earned today, for the caps. */
export async function getDailyTotals(
  accountId: string,
  day: string,
  tx?: DbOrTx,
): Promise<DailyTotals> {
  const db = tx ?? getDb();
  if (!db) return { coins: 0, xp: 0, firstWinClaimed: false };
  try {
    const rows = await db
      .select({
        coins: dailyEarnings.coins,
        xp: dailyEarnings.xp,
        firstWinClaimed: dailyEarnings.firstWinClaimed,
      })
      .from(dailyEarnings)
      .where(and(eq(dailyEarnings.accountId, accountId), eq(dailyEarnings.day, day)));
    return rows[0] ?? { coins: 0, xp: 0, firstWinClaimed: false };
  } catch {
    // Failing OPEN would let the cap be bypassed by breaking a query. Report
    // the cap as already met so nothing is paid until the read works again.
    return { coins: Number.MAX_SAFE_INTEGER, xp: Number.MAX_SAFE_INTEGER, firstWinClaimed: true };
  }
}

/** Records what was actually paid today, so the caps count real payouts. */
export async function addDailyTotals(
  accountId: string,
  day: string,
  coins: number,
  xp: number,
  firstWin: boolean,
  tx?: DbOrTx,
): Promise<void> {
  const db = tx ?? getDb();
  if (!db) return;
  await db
    .insert(dailyEarnings)
    .values({
      accountId,
      day,
      coins: Math.round(coins),
      xp: Math.round(xp),
      firstWinClaimed: firstWin,
    })
    .onConflictDoUpdate({
      target: [dailyEarnings.accountId, dailyEarnings.day],
      set: {
        coins: sql`${dailyEarnings.coins} + ${Math.round(coins)}`,
        xp: sql`${dailyEarnings.xp} + ${Math.round(xp)}`,
        // Once true it stays true — a later match must not un-claim it.
        firstWinClaimed: sql`${dailyEarnings.firstWinClaimed} or ${firstWin}`,
      },
    });
}
