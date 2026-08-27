import { eq, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import {
  accounts,
  coinLedger,
  dailyEarnings,
  dailyQuests,
  equipped,
  inventory,
  kingdomStats,
  participants,
  profiles,
} from "./schema.js";
import { levelFromXp } from "../engine/rewards.js";
import { logger } from "../util/logger.js";

/**
 * Data export and account deletion.
 *
 * These are rights, not features: the GDPR calls them access (Art. 15),
 * portability (Art. 20) and erasure (Art. 17), and the CCPA has close
 * equivalents. They are self-serve on purpose — a right you have to email
 * somebody to exercise is one most people never do.
 */

/**
 * Everything held about one account, as a plain object.
 *
 * Deliberately assembled from the tables rather than a curated summary: an
 * export that quietly omits something is worse than none, because it tells the
 * person they have seen everything.
 */
export async function exportAccount(accountId: string): Promise<object | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    if (!account) return null;

    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.accountId, accountId));

    const [kingdoms, ledger, owned, worn, quests, earnings, matches] = await Promise.all([
      db.select().from(kingdomStats).where(eq(kingdomStats.accountId, accountId)),
      db.select().from(coinLedger).where(eq(coinLedger.accountId, accountId)),
      db.select().from(inventory).where(eq(inventory.accountId, accountId)),
      db.select().from(equipped).where(eq(equipped.accountId, accountId)),
      db.select().from(dailyQuests).where(eq(dailyQuests.accountId, accountId)),
      db.select().from(dailyEarnings).where(eq(dailyEarnings.accountId, accountId)),
      db.select().from(participants).where(eq(participants.accountId, accountId)),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      note: "Everything Elementals holds about this account. Coins have no real-world value.",
      account: {
        createdAt: account.createdAt,
        lastSeenAt: account.lastSeenAt,
        status: account.status,
        // The bracket, because the birth date was never stored.
        ageBracket: account.ageBracket,
      },
      profile: profile
        ? {
            username: profile.username,
            xp: profile.xp,
            level: levelFromXp(profile.xp).level,
          }
        : null,
      kingdomStats: kingdoms,
      coinLedger: ledger,
      inventory: owned,
      equipped: worn,
      dailyQuests: quests,
      dailyEarnings: earnings,
      matches,
    };
  } catch (error) {
    logger.error("Export failed", { accountId, message: (error as Error).message });
    return null;
  }
}

/**
 * Deletes an account permanently.
 *
 * ⚠️ THE PERSON IS ERASED; THE MATCH HISTORY IS NOT. Deleting the account row
 * cascades to the profile, credentials, coins, quests, inventory and equipped
 * items — but `participants.account_id` is ON DELETE SET NULL, so the rows
 * saying "a Fire kingdom placed third in a seven-player match" survive with the
 * link to a person removed.
 *
 * That is deliberate and is what the policy promises. Those rows are how the
 * game is balanced across sixteen kingdoms; cascading them would mean every
 * erasure request quietly corrupted the balance record, and anonymised rows are
 * no longer personal data.
 *
 * The name is scrubbed explicitly, because it was snapshotted onto the row and
 * a username can identify someone even without the account behind it.
 */
export async function deleteAccount(accountId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  try {
    await db.transaction(async (tx) => {
      // Scrub the display name BEFORE the cascade nulls the link, or there
      // would be no way left to find these rows.
      await tx
        .update(participants)
        .set({ name: "Deleted player" })
        .where(eq(participants.accountId, accountId));

      await tx.delete(accounts).where(eq(accounts.id, accountId));
    });

    logger.info("Account deleted", { accountId });
    return true;
  } catch (error) {
    logger.error("Deletion failed", { accountId, message: (error as Error).message });
    return false;
  }
}

/** Records the age bracket decided at sign-up. The date itself is never kept. */
export async function setAgeBracket(accountId: string, bracket: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .update(accounts)
      .set({ ageBracket: bracket })
      .where(eq(accounts.id, accountId));
  } catch (error) {
    logger.warn("Could not record age bracket", { message: (error as Error).message });
  }
}

/** Whether this account has passed the age gate yet. */
export async function hasAgeBracket(accountId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    const rows = await db
      .select({ bracket: accounts.ageBracket })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    return Boolean(rows[0]?.bracket);
  } catch {
    // Fail CLOSED: if we cannot tell, treat the gate as unpassed rather than
    // waving an unverified account through.
    return false;
  }
}

/** Accounts created before the gate existed, for a one-off backfill prompt. */
export async function countUngated(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  try {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(accounts)
      .where(sql`${accounts.ageBracket} is null`);
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}
