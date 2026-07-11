import { randomUUID } from "node:crypto";

/**
 * Generates a stable unique identifier (e.g. for players). Distinct from a
 * socket id, so a player id can persist across reconnects while their transport
 * connection changes.
 */
export function createId(): string {
  return randomUUID();
}
