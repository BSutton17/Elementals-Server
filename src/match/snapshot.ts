import type { Match } from "./Match.js";
import type { MatchConfig } from "./matchConfig.js";
import type { MatchPlayer, MatchVisibility } from "./types.js";
import { cosmeticById } from "../data/cosmetics.js";
import type { Paint } from "../data/cosmetics.js";

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
  maxActivePlayers: number;
  eliminatedSeeAllHealth: boolean;
  /** "private" (code + host) or "public" (matchmade, hostless, self-starting). */
  visibility: MatchVisibility;
  /**
   * When a public lobby launches itself, as an absolute timestamp, or null.
   *
   * A DEADLINE, not a remaining duration: "18 seconds left" drifts by each
   * client's own latency and they end up disagreeing about when the match
   * begins. `serverTime` above is what a client aligns this against.
   */
  startsAt: number | null;
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
  // Cosmetics are resolved HERE rather than when the seat is created, because a
  // player can change kingdom in the lobby and their castle must change with
  // it. Cheap: a map lookup per seat over a table already in memory.
  const players = view.players.map((player) =>
    player.kingdomId
      ? { ...player, castlePaint: paintFor(player, player.kingdomId) }
      : player,
  );
  return {
    roomCode: view.roomCode,
    phase: view.phase,
    tick: view.tick,
    serverTime: Date.now(),
    hostId: view.hostId,
    winnerId: view.winnerId,
    maxPlayers: view.maxPlayers,
    maxActivePlayers: view.maxActivePlayers,
    eliminatedSeeAllHealth: view.eliminatedSeeAllHealth,
    visibility: view.visibility,
    startsAt: view.startsAt,
    config: view.config,
    you: match.getPlayer(forPlayerId) ?? null,
    players,
    projectiles: [],
  };
}


/**
 * The paint for one seat's castle, or undefined for the standard look.
 *
 * The seat carries the account's whole loadout (resolved once at the
 * handshake), so switching kingdom in the lobby picks up that kingdom's skin
 * with no further reads.
 */
function paintFor(player: MatchPlayer, kingdomId: string): Paint | undefined {
  const itemId = player.loadout?.[kingdomId]?.castle;
  if (!itemId) return undefined;
  const item = cosmeticById(itemId);
  // A skin that no longer exists renders as the default rather than as nothing:
  // retiring an item must never blank somebody's castle mid-match.
  return item?.paint;
}
