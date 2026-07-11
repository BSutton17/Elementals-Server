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
 */
const loadEnvFiles = (): void => {
  const files = [".env", `.env.${rawEnvironment ?? "development"}`, ".env.local"];
  for (const file of files) {
    try {
      process.loadEnvFile(file);
    } catch {
      // File does not exist / not readable — expected; ignore.
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
const DEFAULT_DEV_ORIGIN = "http://localhost:5173"; // Vite dev server default

/**
 * Allowed CORS origins. In development this defaults to the Vite dev server.
 * In production an explicit CLIENT_ORIGIN is required — we do not fall back to a
 * permissive default; an unset value blocks cross-origin clients (fail closed).
 */
const resolveCorsOrigins = (raw: string | undefined): string[] => {
  const configured = (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.length > 0) return configured;
  if (isDevelopment) return [DEFAULT_DEV_ORIGIN];

  logger.warn(
    "No CLIENT_ORIGIN configured outside development; cross-origin clients will be blocked",
    { environment },
  );
  return [];
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
  reconnect: {
    // Default from balance; overridable per environment (and for tests).
    graceMs: toNumber(process.env.RECONNECT_GRACE_MS, RECONNECT.GRACE_MS),
  },
} as const;

// Apply the resolved log level so config is the single source of truth for it.
logger.setLevel(config.logging.level);
