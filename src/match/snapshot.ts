import type { Match } from "./Match.js";
import type { MatchConfig } from "./matchConfig.js";
import type { MatchPlayer } from "./types.js";

/**
 * The complete authoritative snapshot sent to a client to (re)build its view of
 * a match — used for reconnection restoration and, later, initial join/resync
 * (see SOCKET_EVENTS.md §4 `state:full`).
 *
 * `you` is the requesting player's full record so a reconnecting client can
 * resume seamlessly; `players` is every player in the match.
 *
 * SINGLE EXTENSION POINT: as gameplay systems are implemented, the player's
 * runtime state (castle HP, shields, citizens/money, passive & active status
 * effects, cooldowns, ability upgrade levels, selected target, buffs/debuffs,
 * critical modifiers, combos, …) is added to the Player model and flows through
 * `buildMatchSnapshot` here — so restoration stays complete without touching the
 * reconnection handler. None of those systems exist yet, so today a player
 * record carries identity, kingdom, and connection state.
 */
export interface MatchSnapshot {
  roomCode: string;
  phase: string;
  /** Master match timer (server tick). */
  tick: number;
  /** Wall-clock time the snapshot was built, so the client can align timers. */
  serverTime: number;
  hostId: string | null;
  winnerId: string | null;
  maxPlayers: number;
  /** Ruleset snapshot once the match has started; null while in the lobby. */
  config: MatchConfig | null;
  /** The requesting player's own full record (null if not in the match). */
  you: MatchPlayer | null;
  /**
   * Every player in the match — this is the match-wide battlefield state. Each
   * player's runtime state (statuses, active effects, cooldowns, …) travels on
   * their record as those systems are implemented.
   */
  players: MatchPlayer[];
  /**
   * In-flight projectiles on the battlefield. Empty until the projectile system
   * exists; the Match will own the authoritative list and it is read here.
   */
  projectiles: unknown[];
}

/**
 * Builds the full authoritative snapshot of `match` for the given player,
 * covering both the player's own state and the current match-wide battlefield
 * state (all players, timers, and — once they exist — projectiles).
 */
export function buildMatchSnapshot(
  match: Match,
  forPlayerId: string,
): MatchSnapshot {
  const view = match.serialize();
  return {
    roomCode: view.roomCode,
    phase: view.phase,
    tick: view.tick,
    serverTime: Date.now(),
    hostId: view.hostId,
    winnerId: view.winnerId,
    maxPlayers: view.maxPlayers,
    config: view.config,
    you: match.getPlayer(forPlayerId) ?? null,
    players: view.players,
    projectiles: [],
  };
}
