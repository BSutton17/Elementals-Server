import type { Config } from "drizzle-kit";

/**
 * Migration configuration.
 *
 * Run through the npm scripts, which pass `--env-file=.env` so DATABASE_URL is
 * present. Generated SQL is committed under `drizzle/` so the schema's history
 * is reviewable and reproducible rather than living only in someone's database.
 */
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  verbose: true,
  strict: true,
} satisfies Config;
