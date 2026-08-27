import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb, closeDb } from "./client.js";
import { logger } from "../util/logger.js";

/**
 * Applies any pending migrations from `drizzle/`, then exits.
 *
 * Run explicitly (`npm run db:migrate`) rather than on server boot. A game
 * server that migrates as it starts will, on the day a migration fails, refuse
 * to start at all — turning a schema problem into an outage. Migrating is a
 * deploy step; serving matches is not.
 */
async function main(): Promise<void> {
  const db = getDb();
  if (!db) {
    logger.error("DATABASE_URL is not set - nothing to migrate");
    process.exit(1);
  }

  logger.info("Applying migrations");
  await migrate(db, { migrationsFolder: "./drizzle" });
  logger.info("Migrations applied");
  await closeDb();
}

main().catch(async (error: Error) => {
  logger.error("Migration failed", { message: error.message });
  await closeDb().catch(() => {});
  process.exit(1);
});
