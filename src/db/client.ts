import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { logger } from "../util/logger.js";
import * as schema from "./schema.js";

/**
 * The database connection.
 *
 * ⚠️ THE GAME MUST NEVER DEPEND ON THIS. Matches are simulated entirely in
 * memory and are the product; accounts are a feature bolted alongside. If
 * Postgres is slow, unreachable, or simply not configured, kingdoms keep
 * fighting and room codes keep working — sign-in is what degrades, and it
 * degrades to "you are a guest", which is a state the whole game already
 * supports.
 *
 * That is why this module never throws on startup and never connects at import
 * time. `getDb()` returns null when there is no database, and every caller is
 * expected to handle null rather than assume a connection.
 */

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * A transaction handle. Drizzle types these differently from the connection —
 * a transaction has no `$client` — so a function that must work either inside
 * or outside a transaction takes `DbOrTx`, not `Database`.
 */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Whatever a query can be run against. */
export type DbOrTx = Database | Transaction;

let client: postgres.Sql | null = null;
let database: Database | null = null;
/** Log the "no database" warning once, not on every request. */
let warnedMissing = false;

/**
 * The connection pool, or null when `DATABASE_URL` is unset.
 *
 * Connections are made lazily on first use. `postgres` handles pooling and
 * reconnection internally, so there is nothing to retry here.
 *
 * NOTE ON SUPABASE: the connection string must be the **Session** pooler
 * (port 5432), not the direct connection (IPv6-only, unreachable from Heroku)
 * and not the transaction pooler (port 6543, which forbids prepared
 * statements). Session mode supports prepared statements, so the default
 * `prepare: true` is correct and is deliberately not overridden.
 */
export function getDb(): Database | null {
  if (database) return database;

  if (blockedByTestGuard()) return null;

  const url = process.env.DATABASE_URL;
  if (!url) {
    if (!warnedMissing) {
      warnedMissing = true;
      logger.warn(
        "DATABASE_URL is not set - accounts are disabled, the game runs as guest-only",
      );
    }
    return null;
  }

  client = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {}, // Postgres NOTICEs are noise in the game log.
  });
  database = drizzle(client, { schema });
  logger.info("Database connected");
  return database;
}

/**
 * ⚠️ TESTS MUST NEVER REACH THE REAL DATABASE.
 *
 * `config/index.ts` calls `process.loadEnvFile('.env')` at import time, so ANY
 * module that transitively imports config — which is most of them — pulls the
 * production DATABASE_URL into the process. A test that merely imports
 * `db/accounts.js` would therefore write to live Supabase, and one already did:
 * it created a real account row before this guard existed.
 *
 * `npm test` sets NODE_ENV=test via `--env-file=.env.test`. A test that
 * genuinely wants a database opts back in with ALLOW_TEST_DB=true, pointed at a
 * throwaway one.
 */
function blockedByTestGuard(): boolean {
  return process.env.NODE_ENV === "test" && process.env.ALLOW_TEST_DB !== "true";
}

/**
 * Whether accounts are available at all. Cheap; does not open a connection.
 *
 * Deliberately answers the same question `getDb()` does, guard included — the
 * two disagreeing is how you end up with a startup line proudly reporting
 * "accounts: enabled" on a server where every account lookup returns null.
 */
export function isDatabaseConfigured(): boolean {
  if (blockedByTestGuard()) return false;
  return Boolean(process.env.DATABASE_URL);
}

/** Closes the pool during graceful shutdown. Safe to call when never opened. */
export async function closeDb(): Promise<void> {
  if (!client) return;
  await client.end({ timeout: 5 });
  client = null;
  database = null;
}
