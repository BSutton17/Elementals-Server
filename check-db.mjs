// One-off connection check for the Supabase database.
//
// Run:  node --env-file=.env check-db.mjs
//
// Confirms three things, in order, because they fail for different reasons:
//   1. DATABASE_URL is present and looks like a Postgres URL
//   2. we can actually reach the server and log in
//   3. we have permission to create tables (migrations will need this)
//
// Delete this file once the real database layer lands - it exists only to give
// a clear green light before any schema work starts.

import postgres from "postgres";

const url = process.env.DATABASE_URL;

if (!url) {
  console.error("\n  FAIL  DATABASE_URL is not set.");
  console.error("        Check Server/.env exists and that you ran this with");
  console.error("        --env-file=.env\n");
  process.exit(1);
}

// Never print the password.
const redacted = url.replace(/:\/\/([^:]+):[^@]*@/, "://$1:****@");
console.log(`\n  Connecting to ${redacted}`);

const host = url.split("@")[1]?.split(":")[0] ?? "";
const port = url.split("@")[1]?.split(":")[1]?.split("/")[0] ?? "";

if (host.startsWith("db.") && host.endsWith(".supabase.co")) {
  console.warn(
    "\n  WARN  This is the DIRECT connection string (db.*.supabase.co).",
  );
  console.warn("        It is IPv6-only and will fail on Heroku.");
  console.warn("        Use the Session pooler string instead - see step 3.\n");
}

if (port === "6543") {
  console.warn(
    "\n  WARN  Port 6543 is TRANSACTION mode. This server holds long-lived",
  );
  console.warn("        connections, so use SESSION mode (port 5432) instead.\n");
}

const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 });

try {
  const [{ version }] = await sql`SELECT version()`;
  console.log(`\n  OK    Connected.`);
  console.log(`        ${version.split(",")[0]}`);

  // Migrations will need to create tables. Prove we can before we rely on it.
  await sql`CREATE TABLE IF NOT EXISTS _kingdoms_write_check (id int)`;
  await sql`DROP TABLE _kingdoms_write_check`;
  console.log(`  OK    Can create and drop tables.`);

  console.log(`\n  Database is ready. Tell Claude you're done.\n`);
  await sql.end();
  process.exit(0);
} catch (error) {
  console.error(`\n  FAIL  ${error.message}\n`);

  const hint = {
    ENOTFOUND: "Hostname is wrong - re-copy the string from the dashboard.",
    ETIMEDOUT: "Could not reach the host. If using db.*.supabase.co, that is the IPv6 problem - switch to the Session pooler.",
    ECONNREFUSED: "Reached the host but the port refused. Check the port is 5432.",
  }[error.code];

  if (hint) console.error(`        ${hint}\n`);
  else if (/password|auth/i.test(error.message)) {
    console.error("        Password is wrong, or it contains characters that need");
    console.error("        URL-encoding (@ : / ? # [ ] are the usual culprits).");
    console.error("        Easiest fix: reset it in the dashboard to a plain");
    console.error("        letters-and-numbers password.\n");
  }
  process.exit(1);
}
