import type { KingdomId } from "../data/kingdoms.js";

/** Lifecycle phase of a match (see DATA_MODELS.md → Match). */
export type MatchPhase = "lobby" | "starting" | "active" | "ended";

/**
 * A participant as tracked by the Match at the room/connection level.
 *
 * This is intentionally lightweight — the full gameplay Player model (castle,
 * economy, abilities, statuses…) is layered on separately as those systems land
 * (see DATA_MODELS.md → Player and the `player/` folder).
 */
export interface MatchPlayer {
  /** Stable player id (persists across reconnects within a match). */
  id: string;
  /** Current transport connection; null while disconnected. */
  socketId: string | null;
  /** Display name. */
  name: string;
  /** Selected kingdom, or null until chosen in the lobby. */
  kingdomId: KingdomId | null;
  /** Lobby ready state. */
  ready: boolean;
  /** Whether the player currently has a live connection. */
  connected: boolean;
}
