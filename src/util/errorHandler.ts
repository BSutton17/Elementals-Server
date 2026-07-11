import { logger } from "./logger.js";

/**
 * Registers process-level error handlers so an uncaught error in one operation
 * does not crash the entire server — which would drop every active match and
 * disconnect all players.
 *
 * This is a LAST-RESORT safety net. The primary defense is catching errors at
 * operation boundaries (e.g. inside each socket-event handler) so failures stay
 * scoped to the request that caused them. Anything that escapes to here is
 * logged (never silently swallowed); the process keeps running.
 */
export function registerGlobalErrorHandlers(): void {
  process.on("uncaughtException", (error: Error) => {
    logger.error("Uncaught exception (server kept alive)", {
      message: error.message,
      stack: error.stack,
    });
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error("Unhandled promise rejection (server kept alive)", {
      message: error.message,
      stack: error.stack,
    });
  });
}
