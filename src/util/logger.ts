/**
 * Centralized logging utility for the Kingdoms server.
 *
 * Records connections, disconnections, errors, and other important server
 * events with consistent, timestamped, level-tagged output. Dependency-free
 * (wraps the console) so it can be used anywhere on the server without setup.
 *
 * The minimum level is controlled by the LOG_LEVEL env var (debug|info|warn|
 * error); anything below it is suppressed. Defaults to "info".
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const PREFIX = "Kingdoms";

const resolveLevel = (value: string | undefined): LogLevel =>
  value !== undefined && value in LEVEL_ORDER ? (value as LogLevel) : "info";

/**
 * Current minimum level. Initialized from LOG_LEVEL so the logger works even
 * before the configuration system loads; the config system may override it via
 * `setLevel` to apply environment-aware defaults (see config.ts).
 */
let minLevel: LogLevel = resolveLevel(process.env.LOG_LEVEL);

/** Optional structured context attached to a log line. */
export type LogMeta = Record<string, unknown>;

const shouldLog = (level: LogLevel): boolean =>
  LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];

const write = (level: LogLevel, message: string, meta?: LogMeta): void => {
  if (!shouldLog(level)) return;

  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${level.toUpperCase()}] [${PREFIX}] ${message}`;

  // Route to the matching console method so warnings/errors surface correctly.
  const sink =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;

  if (meta !== undefined) {
    sink(line, meta);
  } else {
    sink(line);
  }
};

export const logger = {
  debug: (message: string, meta?: LogMeta): void => write("debug", message, meta),
  info: (message: string, meta?: LogMeta): void => write("info", message, meta),
  warn: (message: string, meta?: LogMeta): void => write("warn", message, meta),
  error: (message: string, meta?: LogMeta): void => write("error", message, meta),
  /** Override the minimum level at runtime (used by the config system). */
  setLevel: (level: LogLevel): void => {
    minLevel = level;
  },
  /** Current minimum level. */
  getLevel: (): LogLevel => minLevel,
} as const;
