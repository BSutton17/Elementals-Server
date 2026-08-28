import { eq } from "drizzle-orm";
import { getDb } from "./client.js";
import { authIdentities } from "./schema.js";
import { config } from "../config/index.js";
import { logger } from "../util/logger.js";

/**
 * Who counts as an administrator.
 *
 * ⚠️ ASKED ON EVERY REQUEST, NEVER TRUSTED FROM THE CLIENT. The profile
 * response carries an `admin` flag so the UI can show the tools, but that flag
 * is a HINT for rendering — every admin action re-checks here before doing
 * anything. A client that flips the flag in its own memory gets the button and
 * a 403.
 *
 * Membership is by the email on the sign-in identity (see config.admin.emails
 * for why email and not account id).
 */

/**
 * Whether one email address is an admin's.
 *
 * Separate from the lookup so the RULE can be tested without a database — the
 * membership question is pure, and only "which emails does this account have"
 * needs Postgres.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return config.admin.emails.includes(email.trim().toLowerCase());
}

/** Cache: the answer changes only when someone edits an environment variable. */
const cache = new Map<string, { admin: boolean; at: number }>();
const TTL_MS = 60_000;

export async function isAdmin(accountId: string): Promise<boolean> {
  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.admin;

  const db = getDb();
  if (!db) return false;
  try {
    const rows = await db
      .select({ email: authIdentities.email })
      .from(authIdentities)
      .where(eq(authIdentities.accountId, accountId));
    const admin = rows.some((r) => isAdminEmail(r.email));
    cache.set(accountId, { admin, at: Date.now() });
    return admin;
  } catch (error) {
    // ⚠️ FAIL CLOSED. An unreadable identity table means "not an admin", never
    // "assume yes" — the whole point of the check is that it gates writes.
    logger.warn("Admin check failed", { message: (error as Error).message });
    return false;
  }
}

/** Drops the memoised answer — for tests, and after an account is deleted. */
export function clearAdminCache(): void {
  cache.clear();
}
