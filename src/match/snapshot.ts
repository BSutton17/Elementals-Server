import type { Match } from "./Match.js";
import type { MatchConfig } from "./matchConfig.js";
import type { MatchPlayer, MatchVisibility } from "./types.js";
import { botCastleFor, cosmeticById } from "../data/cosmetics.js";
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
      ? { ...player, castlePaint: paintFor(player, player.kingdomId, view.roomCode) }
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
/**
 * Resolves every seat's castle paint once and stamps it onto the seat.
 *
 * ⚠️ CALL THIS AT MATCH START. The live channel is `state:sync`, and its player
 * objects are built from PlayerState — the engine's view, which has never
 * carried cosmetics. Only `state:full` and the join ack went through
 * `buildMatchSnapshot`, so paint arrived once and was then overwritten twenty
 * times a second by syncs that did not have it. Every castle on the
 * battlefield rendered standard: bots, and everyone else's equipped skins too.
 *
 * Stamping the seats means the paint rides along with `match:started` and every
 * lobby update, and the client keeps it beside the live state instead of
 * expecting it to survive a sync. Resolved ONCE rather than per tick, because
 * it cannot change mid-match and a 20 Hz broadcast is the wrong place to
 * re-send a constant.
 */
export function stampCastlePaint(match: Match): void {
  for (const player of match.getPlayers()) {
    if (!player.kingdomId) continue;
    player.castlePaint = paintFor(player, player.kingdomId, match.roomCode);
  }
}

function paintFor(
  player: MatchPlayer,
  kingdomId: string,
  roomCode: string,
): Paint | undefined {
  // Same room and same player: one number, used for anything about this seat
  // that has to look identical on every screen.
  const seed = seedFrom(`${roomCode}:${player.id}`);

  // ⚠️ BOTS ROLL FOR A SKIN; PEOPLE WEAR WHAT THEY EQUIPPED. A bot has no
  // loadout, so without this every bot in the game is the default castle and a
  // lobby of them looks like a product page. It only fires for kingdoms with a
  // full set — see botCastleFor.
  const item = player.isBot
    ? botCastleFor(kingdomId, seed)
    : (() => {
        const itemId = player.loadout?.[kingdomId]?.castle;
        // A skin that no longer exists renders as the default rather than as
        // nothing: retiring an item must never blank somebody's castle
        // mid-match.
        return itemId ? cosmeticById(itemId) : undefined;
      })();

  if (!item?.paint?.varies) return item?.paint;
  return { ...item.paint, variantSeed: seed };
}

/**
 * A small stable hash. FNV-1a: not cryptographic and does not need to be — it
 * only has to give the same answer on every machine, which `Math.random` and
 * anything involving `Date` do not.
 */
function seedFrom(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
