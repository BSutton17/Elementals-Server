import type { KingdomId } from "../data/kingdoms.js";
import type { PerkId } from "../data/perks.js";
import type { Paint } from "../data/cosmetics.js";

/** Lifecycle phase of a match (see DATA_MODELS.md → Match). */
export type MatchPhase = "lobby" | "starting" | "active" | "ended";

/**
 * How a room is entered.
 *
 * "private" is a room someone made and shared a code for: it has a host, and it
 * starts when that host says so. "public" is matchmade — strangers are seated
 * together, there is no host at all, and the room starts itself on a timer.
 */
export type MatchVisibility = "private" | "public";

/**
 * A participant as tracked by the Match at the room/connection level.
 *
 * This is intentionally lightweight — the full gameplay Player model (castle,
 * economy, abilities, statuses…) is layered on separately as those systems land
 * (see DATA_MODELS.md → Player and the `player/` folder).
 */
/** The three shipped bot strengths, each backed by its own trained model. */
export type BotDifficulty = "easy" | "medium" | "hard";

export interface MatchPlayer {
  /** Stable player id (persists across reconnects within a match). */
  id: string;
  /** Current transport connection; null while disconnected. */
  socketId: string | null;
  /** Display name. */
  name: string;
  /**
   * The signed-in account behind this seat, or null for a guest or a bot.
   *
   * Set once when the seat is created and never re-read from the client. It is
   * what ties a finished match to a profile; without it a match result has
   * nowhere to be recorded.
   */
  accountId?: string | null;
  /**
   * Account level, shown beside this player's name on the battlefield.
   *
   * Resolved once when the seat is created, from the profile the handshake
   * already fetched — never re-read mid-match, so a level-up during a game
   * appears next time rather than mid-fight.
   *
   * Undefined for guests and bots, who have no level. The badge is simply
   * absent for them: a dash would read as a rendering fault.
   */
  level?: number;
  /**
   * How this seat's castle is painted, or undefined for the kingdom's standard
   * look.
   *
   * ⚠️ THE PAINT TRAVELS, NOT THE ITEM ID. Sending an id would mean every
   * client needed the cosmetics catalogue in sync to render anyone else — and
   * a client one release behind would show a stranger the wrong castle. The
   * resolved values are a handful of bytes and cannot drift.
   */
  castlePaint?: Paint;
  /**
   * This account's equipped cosmetics, kept on the seat so the snapshot can
   * resolve a castle's paint without a database read. Internal: the client is
   * sent the resolved `castlePaint`, never this.
   */
  loadout?: Record<string, Partial<Record<string, string>>>;
  /** Selected kingdom, or null until chosen in the lobby. */
  kingdomId: KingdomId | null;
  /**
   * The player's chosen perks — distinct ids, up to `PERKS_PER_PLAYER`. Empty
   * until they start picking; a full selection is required to ready up.
   * Optional so lightweight fixtures need not spell it out.
   */
  perks?: PerkId[];
  /** Lobby ready state. */
  ready: boolean;
  /** Whether the player currently has a live connection. */
  connected: boolean;
  /**
   * True when this seat is driven by a trained AI rather than a person.
   *
   * An explicit flag, never inferred from the name — a player calling
   * themselves "BOT" must not become one, and a bot must stay a bot when
   * renamed. Everything else about the seat is unchanged: a bot holds a normal
   * MatchPlayer, occupies a normal seat, picks a normal kingdom, and counts
   * toward the same capacity limits, because it plays the same game.
   */
  isBot?: boolean;
  /** Which trained model drives it. Meaningless unless `isBot`. */
  botDifficulty?: BotDifficulty;
  /** A spectator watches the match without a kingdom/castle — never gets a
   *  gameplay PlayerState, doesn't count toward the active-player cap or the
   *  start requirements. The 8th seat can only ever be a spectator. */
  spectator?: boolean;
}
