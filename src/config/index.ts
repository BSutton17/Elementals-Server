import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECONNECT } from "../data/balance.js";
import { logger, type LogLevel } from "../util/logger.js";

/**
 * Environment-aware configuration system for the Kingdoms server.
 *
 * Responsibilities:
 *  - Detect the runtime environment (NODE_ENV).
 *  - Load `.env` files for local development (dependency-free, via Node's
 *    built-in `process.loadEnvFile`).
 *  - Resolve transport/process settings from environment variables with
 *    environment-appropriate defaults.
 *
 * This owns transport/process configuration only. Gameplay tunables live in
 * data/balance (see ARCHITECTURE.md).
 */

export type Environment = "development" | "production" | "test";

// --- .env loading (dev convenience) -----------------------------------------

const rawEnvironment = process.env.NODE_ENV;

/**
 * Load env files if present, low-to-high precedence. Missing files are ignored,
 * so this is a no-op in environments that inject variables directly (e.g. prod).
 * Later files do not overwrite variables already set (Node's loadEnvFile only
 * sets keys that are not already defined in process.env).
 *
 * ⚠️ RESOLVED AGAINST THIS PACKAGE, NOT THE WORKING DIRECTORY. `loadEnvFile(".env")`
 * looks in `process.cwd()`, so the server picked up its database credentials
 * only when it happened to be launched from `Server/`. Started from the repo
 * root, from an editor, or by a watcher with a different cwd, it booted with no
 * DATABASE_URL and no JWT_SECRET — and the failure is nearly silent, because
 * everything still runs: matches work, sockets connect, and only the account
 * layer quietly stops answering. That is a 503 on `/profile` and an admin check
 * that fails closed, which looks exactly like "my account is broken".
 *
 * The cwd is still tried as a fallback, so a deployment that puts .env
 * somewhere else keeps working.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const loadEnvFiles = (): void => {
  const names = [".env", `.env.${rawEnvironment ?? "development"}`, ".env.local"];
  for (const name of names) {
    for (const candidate of [resolve(packageRoot, name), name]) {
      try {
        process.loadEnvFile(candidate);
        break; // found it; the cwd copy would only duplicate
      } catch {
        // Not there — try the next location, then the next file.
      }
    }
  }
};

loadEnvFiles();

// --- helpers ----------------------------------------------------------------

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolveEnvironment = (value: string | undefined): Environment => {
  if (value === "production" || value === "test") return value;
  return "development";
};

// --- resolved values --------------------------------------------------------

const environment = resolveEnvironment(rawEnvironment);
const isProduction = environment === "production";
const isDevelopment = environment === "development";

const DEFAULT_PORT = 3001;
// CORS origins are scheme + host + port only — no path. The Vite dev server
// serves the client at localhost:5173.
const DEFAULT_DEV_ORIGIN = "http://localhost:5173";
const DEFAULT_PROD_ORIGIN = "https://elementals-game.netlify.app";
/**
 * Allowed CORS origins. In development this defaults to the local Vite dev
 * server so a locally-run client can connect. In production we default to the
 * deployed client so the published frontend can connect without requiring extra
 * environment configuration.
 */
const resolveCorsOrigins = (raw: string | undefined): string[] => {
  const configured = (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.length > 0) return configured;
  if (isDevelopment) return [DEFAULT_DEV_ORIGIN];
  if (isProduction) return [DEFAULT_PROD_ORIGIN];

  logger.warn(
    "No CLIENT_ORIGIN configured outside development; cross-origin clients will be blocked",
    { environment },
  );
  return [];
};

/**
 * Accounts that may use the admin tools.
 *
 * ⚠️ BY EMAIL, NOT BY ACCOUNT ID. An account id is a UUID minted by whichever
 * database the server is pointed at, so the same person is a different id in
 * development, in test and in production — an id here would have to be looked
 * up and re-entered three times, and would silently grant nothing after a
 * database reset. The Google address is the one identifier that is the same
 * person everywhere.
 *
 * Overridable so a second admin never needs a code change, but defaulted so a
 * fresh deployment has one without any configuration at all.
 */
const DEFAULT_ADMIN_EMAILS = ["btpitch27@gmail.com"];

const resolveAdminEmails = (raw: string | undefined): string[] => {
  const configured = (raw ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_ADMIN_EMAILS;
};

const resolveLogLevel = (raw: string | undefined): LogLevel => {
  const allowed: LogLevel[] = ["debug", "info", "warn", "error"];
  if (raw && (allowed as string[]).includes(raw)) return raw as LogLevel;
  // Environment-appropriate default: verbose locally, quieter in production.
  return isDevelopment ? "debug" : "info";
};

export const config = {
  environment,
  isProduction,
  isDevelopment,
  server: {
    port: toNumber(process.env.PORT, DEFAULT_PORT),
    host: process.env.HOST ?? "0.0.0.0",
  },
  cors: {
    origins: resolveCorsOrigins(process.env.CLIENT_ORIGIN),
  },
  logging: {
    level: resolveLogLevel(process.env.LOG_LEVEL),
  },
  admin: {
    // Lower-cased on the way in so the comparison never has to remember to.
    emails: resolveAdminEmails(process.env.ADMIN_EMAILS),
  },
  reconnect: {
    // Default from balance; overridable per environment (and for tests).
    graceMs: toNumber(process.env.RECONNECT_GRACE_MS, RECONNECT.GRACE_MS),
  },
} as const;

// Apply the resolved log level so config is the single source of truth for it.
logger.setLevel(config.logging.level);
