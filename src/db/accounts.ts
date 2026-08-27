import { eq, and } from "drizzle-orm";
import { getDb } from "./client.js";
import { accounts, authIdentities, profiles } from "./schema.js";
import { logger } from "../util/logger.js";
import { getLoadout } from "./cosmetics.js";
import { levelFromXp } from "../engine/rewards.js";
import { accountLifetime } from "./cleanup.js";
import { checkUsername, usernameKey, type UsernameError } from "../auth/username.js";

/**
 * Account lookup and creation.
 *
 * Every function here returns null rather than throwing when the database is
 * unavailable. Callers decide what that means: for sign-in it means "try
 * again later", and for everything else it means "this player is a guest".
 */

export interface AccountRecord {
  accountId: string;
  /** null until the player has chosen one - see `needsUsername`. */
  username: string | null;
  /** Lifetime XP. The level is derived from it, never stored. */
  xp: number;
}

export interface ProviderIdentity {
  /** "google" today; "apple" later, with no other change to this file. */
  provider: string;
  /** The provider's permanent id for this person (Google's `sub`). */
  providerUid: string;
  /** Support and recovery only. NEVER used to identify anyone. */
  email?: string;
}

/**
 * Finds the account behind a set of provider credentials, creating it on first
 * sign-in.
 *
 * ⚠️ CONCURRENCY. Two sign-ins for the same brand-new person can race — a
 * double-clicked button is enough. Both would see "no identity yet" and both
 * would create an account, leaving one person with two. The insert therefore
 * uses ON CONFLICT DO NOTHING against the (provider, provider_uid) primary key
 * and re-reads afterwards, so the loser of the race adopts the winner's
 * account instead of creating a second one.
 */
export async function findOrCreateAccount(
  identity: ProviderIdentity,
): Promise<AccountRecord | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const existing = await lookup(db, identity);
    if (existing) {
      // ⚠️ A REAL SIGN-IN PROMOTES A THROWAWAY ACCOUNT TO PERMANENT.
      //
      // Identities are keyed on (provider, provider_uid), so the account you
      // create signing in locally is THE SAME ROW you land on signing in to
      // production later. Without this, production would adopt that row's
      // two-hour expiry and the sweeper would delete a real player's account.
      //
      // `accountLifetime()` is null wherever accounts are meant to last, so
      // writing it unconditionally clears a stale deadline in production and
      // refreshes it locally.
      await db
        .update(accounts)
        .set({ lastSeenAt: new Date(), expiresAt: accountLifetime() })
        .where(eq(accounts.id, existing.accountId));
      return existing;
    }

    const created = await db.transaction(async (tx) => {
      const [account] = await tx
        .insert(accounts)
        // Outside production this stamps a deadline, so local sign-ins clean
        // up after themselves instead of polluting real data. See db/cleanup.
        .values({ expiresAt: accountLifetime() })
        .returning({ id: accounts.id });
      if (!account) throw new Error("Account insert returned nothing");

      await tx.insert(profiles).values({ accountId: account.id });
      const inserted = await tx
        .insert(authIdentities)
        .values({
          provider: identity.provider,
          providerUid: identity.providerUid,
          accountId: account.id,
          email: identity.email ?? null,
        })
        .onConflictDoNothing()
        .returning({ accountId: authIdentities.accountId });

      // Empty means another request created this identity first. Roll our own
      // orphan account back and let the caller re-read theirs.
      if (inserted.length === 0) {
        await tx.rollback();
      }
      return account.id;
    });

    logger.info("Account created", { accountId: created, provider: identity.provider });
    return { accountId: created, username: null, xp: 0 };
  } catch (error) {
    // A rollback from the race above lands here too: re-read and use whichever
    // account won.
    const raced = await lookup(getDb()!, identity).catch(() => null);
    if (raced) return raced;

    logger.error("Account lookup failed", { message: (error as Error).message });
    return null;
  }
}

/** Reads the account behind an identity, or null if it does not exist yet. */
async function lookup(
  db: NonNullable<ReturnType<typeof getDb>>,
  identity: ProviderIdentity,
): Promise<AccountRecord | null> {
  const rows = await db
    .select({
      accountId: authIdentities.accountId,
      username: profiles.username,
      xp: profiles.xp,
    })
    .from(authIdentities)
    .leftJoin(profiles, eq(profiles.accountId, authIdentities.accountId))
    .where(
      and(
        eq(authIdentities.provider, identity.provider),
        eq(authIdentities.providerUid, identity.providerUid),
      ),
    )
    .limit(1);

  const row = rows[0];
  return row
    ? { accountId: row.accountId, username: row.username ?? null, xp: row.xp ?? 0 }
    : null;
}

/** The profile for an account id, or null if unknown / no database. */
export async function getProfile(accountId: string): Promise<AccountRecord | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select({
        accountId: profiles.accountId,
        username: profiles.username,
        xp: profiles.xp,
      })
      .from(profiles)
      .where(eq(profiles.accountId, accountId))
      .limit(1);
    const row = rows[0];
    return row
      ? { accountId: row.accountId, username: row.username ?? null, xp: row.xp ?? 0 }
      : null;
  } catch (error) {
    logger.error("Profile read failed", { message: (error as Error).message });
    return null;
  }
}


export type SetUsernameError = UsernameError | "TAKEN" | "UNAVAILABLE" | "NO_ACCOUNT";

export interface SetUsernameResult {
  ok: boolean;
  error?: SetUsernameError;
  message?: string;
  username?: string;
}

/**
 * Sets (or changes) an account's username.
 *
 * ⚠️ UNIQUENESS IS THE DATABASE'S JOB, NOT A LOOKUP'S. Checking "is this taken?"
 * and then inserting is a race two people picking the same name at the same
 * moment will win — the gap between the two statements is all they need. The
 * unique index on `username_lower` is what actually guarantees it, so this
 * writes optimistically and treats a unique violation as "taken".
 */
export async function setUsername(
  accountId: string,
  raw: unknown,
): Promise<SetUsernameResult> {
  const check = checkUsername(raw);
  if (!check.ok || !check.username) {
    return { ok: false, error: check.error, message: check.message };
  }

  const db = getDb();
  if (!db) {
    return {
      ok: false,
      error: "UNAVAILABLE",
      message: "Profiles are unavailable right now. Try again shortly.",
    };
  }

  const username = check.username;
  try {
    const updated = await db
      .update(profiles)
      .set({
        username,
        usernameLower: usernameKey(username),
        updatedAt: new Date(),
      })
      .where(eq(profiles.accountId, accountId))
      .returning({ accountId: profiles.accountId });

    if (updated.length === 0) {
      return { ok: false, error: "NO_ACCOUNT", message: "Account not found." };
    }

    logger.info("Username set", { accountId, username });
    return { ok: true, username };
  } catch (error) {
    // 23505 is Postgres' unique_violation. The only unique constraint on this
    // statement is username_lower, so this is unambiguous.
    if ((error as { code?: string }).code === "23505") {
      return {
        ok: false,
        error: "TAKEN",
        message: "That username is taken.",
      };
    }
    logger.error("Username update failed", { message: (error as Error).message });
    return {
      ok: false,
      error: "UNAVAILABLE",
      message: "Could not save that right now. Try again shortly.",
    };
  }
}


export interface MatchIdentity {
  username: string | null;
  level: number;
  /** kingdomId -> slot -> itemId, for resolving a castle's paint. */
  loadout: Record<string, Partial<Record<string, string>>>;
}

/**
 * Everything a match seat needs about a signed-in player, in one read.
 *
 * Fetched once per connection (see index.ts) rather than per seat or per tick:
 * a match must never wait on a database, and none of this changes often enough
 * to be worth re-reading mid-game.
 */
export async function getMatchIdentity(accountId: string): Promise<MatchIdentity | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const [profile, loadout] = await Promise.all([
      getProfile(accountId),
      getLoadout(accountId),
    ]);
    if (!profile) return null;
    return {
      username: profile.username,
      level: levelFromXp(profile.xp).level,
      loadout,
    };
  } catch (error) {
    logger.warn("Match identity read failed", { message: (error as Error).message });
    return null;
  }
}
