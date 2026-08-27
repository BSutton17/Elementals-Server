import { lt, isNotNull, and } from "drizzle-orm";
import { getDb } from "./client.js";
import { accounts } from "./schema.js";
import { config } from "../config/index.js";
import { logger } from "../util/logger.js";

/**
 * Sweeps expired throwaway accounts.
 *
 * Development and production share one database, so every local sign-in leaves
 * a real row behind. Disk space is not the problem — an account is a few
 * hundred bytes. The problem is POLLUTION: without this, a throwaway account
 * from a local run sits in win-rate aggregates forever and can permanently
 * squat a username a real player wants.
 *
 * ⚠️ THIS CAN NEVER DELETE A PLAYER. It only touches rows where `expires_at`
 * is both non-null AND in the past, and production sign-ins always write NULL
 * (see `accountLifetime`). A production server running this sweep is not only
 * safe but useful: it cleans up after developers who are no longer running.
 *
 * Deletion cascades to `auth_identities` and `profiles`, so the account's whole
 * footprint goes with it.
 */

/** How long a non-production account lives before it is swept. */
export const DEV_ACCOUNT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/** How often the sweep runs while the server is up. */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * The `expires_at` to stamp on a newly created account: a deadline for
 * throwaway environments, null (lives forever) everywhere else.
 *
 * ⚠️ EXPIRY IS OPT-IN, AND THAT DIRECTION IS DELIBERATE. The obvious design is
 * "expire unless this is production" — but `config.resolveEnvironment` treats
 * anything that is not exactly "production" as development, so a NODE_ENV that
 * was unset, misspelled, or dropped by a platform change would silently stamp
 * a two-hour deadline on every REAL account and the sweeper would delete them.
 * That failure is invisible until the players are already gone.
 *
 * So the flag has to be set on purpose: `EPHEMERAL_ACCOUNTS=true`, which lives
 * in the local `.env` and is absent everywhere else. Now a misconfiguration
 * means accounts persist that should not have — untidy, and fixable with one
 * DELETE — rather than accounts vanishing that should not have.
 *
 * The production check remains as a second lock: even with the flag set, a
 * server that believes it is production never expires anything.
 */
export function accountLifetime(): Date | null {
  if (config.isProduction) return null;
  if (process.env.EPHEMERAL_ACCOUNTS !== "true") return null;
  return new Date(Date.now() + DEV_ACCOUNT_TTL_MS);
}

/** Deletes every expired throwaway account. Returns how many went. */
export async function sweepExpiredAccounts(): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  try {
    const deleted = await db
      .delete(accounts)
      .where(and(isNotNull(accounts.expiresAt), lt(accounts.expiresAt, new Date())))
      .returning({ id: accounts.id });

    if (deleted.length > 0) {
      logger.info("Swept expired test accounts", { count: deleted.length });
    }
    return deleted.length;
  } catch (error) {
    // A failed sweep is housekeeping that did not happen, never an outage.
    logger.warn("Account sweep failed", { message: (error as Error).message });
    return 0;
  }
}

/**
 * Starts the periodic sweep, and runs one immediately so a server booting
 * after a gap clears whatever the last session left behind.
 *
 * Returns a stop function. `unref()` keeps the timer from holding the process
 * open during shutdown or in tests.
 */
export function startAccountSweeper(): () => void {
  void sweepExpiredAccounts();
  const timer = setInterval(() => void sweepExpiredAccounts(), SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
