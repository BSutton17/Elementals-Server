import type { Match } from "../../match/Match.js";
import type { PlayerState } from "../../match/playerState.js";

/**
 * Party Mode: the shared shape every minigame is built to.
 *
 * ⚠️ ONE SESSION AT A TIME, AND THE SERVER OWNS ALL OF IT. A minigame decides
 * gold and damage, so nothing about it may be settled on a client: the client
 * reports what the player DID ("I reached the exit", "I clicked at 1.2s") and
 * this side decides what that is worth. Every game in the registry follows the
 * same contract so the session machinery never needs to know which one is
 * running.
 *
 * THE FIVE STATES A PLAYER MOVES THROUGH:
 *   playing → done            (finished, with an outcome)
 *   playing → done (failed)   (ran out of time, or got it wrong)
 * Eliminated players are never enrolled; a player eliminated mid-game is
 * dropped from the session on the next tick.
 */

export type PartyGameId =
  | "maze"
  | "spotTheDifference"
  | "blackjack"
  | "memory"
  | "lockpick"
  | "reaction"
  | "quickMath"
  | "buttonMash"
  | "bombAttack"
  | "kingdomThief"
  | "pickAChest";

/** How a player left the game. `null` while they are still in it. */
export type PartyOutcome = "won" | "lost" | null;

export interface PartyPlayerState {
  /** False until they finish; a timed game finishes everyone at once. */
  done: boolean;
  outcome: PartyOutcome;
  /** Tick they finished on — the ordering that decides "last to X". */
  finishedTick: number | null;
  /**
   * Whatever this game needs to remember about this player.
   *
   * ⚠️ BROADCAST TO THE WHOLE ROOM, like the rest of the state. A game with a
   * genuine secret (Blackjack's hole card) keeps it out of here and resolves it
   * server-side — see `sanitizeForWire` on the game.
   */
  data: Record<string, unknown>;
}

export interface PartySession {
  gameId: PartyGameId;
  /** Tick it began, so the client can time its own countdown off the wire. */
  startedTick: number;
  /** Tick everyone is finished at regardless (timed games), else null. */
  endsTick: number | null;
  /** The hard stop, so a stalled table can never hold the session forever. */
  expiresTick: number;
  /** Shared setup: the maze, the two castles, the symbol sequence. */
  shared: Record<string, unknown>;
  players: Record<string, PartyPlayerState>;
  /**
   * The first player to finish.
   *
   * ⚠️ THIS IS THE ATTACK GATE. Attacks are skipped from the moment a minigame
   * starts until somebody completes it — a table cannot defend itself while it
   * is looking at a maze, so letting bots and the monster swing through it
   * would make Party Mode a punishment for playing along.
   */
  firstFinisherId: string | null;
  /** The tick they finished on — the centrepiece grace runs from here. */
  firstFinishTick: number | null;
  /** Finish order, earliest first. The tail is who the result line names. */
  finishOrder: string[];
  /** Set once the session is resolved; it lingers a moment so the client can
   *  show the result banner before it disappears. */
  resolvedTick: number | null;
  /** The result banner, or null for games whose result is "none". */
  resultText: string | null;
}

/** What a game hands back when it sets itself up. */
export interface PartySetup {
  shared: Record<string, unknown>;
  /** Per-player starting data, keyed by player id. */
  perPlayer: Record<string, Record<string, unknown>>;
}

/** One player's move, straight off the wire and NOT yet trusted. */
export interface PartyAction {
  type: string;
  [key: string]: unknown;
}

export interface PartyActionResult {
  ok: boolean;
  /** Why it was refused, for the ack. */
  error?: string;
}

export interface PartyGame {
  readonly id: PartyGameId;
  /** The banner while it runs. */
  readonly description: string;
  /**
   * Seconds before everyone is finished whether they are done or not.
   *
   * A TIMED game (the maze) ends for the whole table at once. A BLOCKING game
   * leaves this null and ends when the last player finishes — production is
   * stopped for anyone still in it, so stalling only ever costs the staller.
   */
  readonly timedSeconds: number | null;
  /**
   * The hard cap, always. Even a blocking game has one: a player who walks away
   * from their keyboard must not hold the next roll hostage forever.
   */
  readonly maxSeconds: number;
  /** True while this game stops the player's gold production. */
  readonly stopsProduction: boolean;

  setup(match: Match, players: PlayerState[]): PartySetup;

  /**
   * Applies one player's action. Mutates their `PartyPlayerState` and settles
   * any reward or damage itself — the session machinery pays nothing.
   */
  act(
    match: Match,
    session: PartySession,
    player: PlayerState,
    action: PartyAction,
  ): PartyActionResult;

  /**
   * Called every tick for a player who has not finished. Games that resolve on
   * a clock (the maze running out) use it; the rest leave it undefined.
   */
  tick?(match: Match, session: PartySession, player: PlayerState): void;

  /**
   * Called ONCE per tick for the session as a whole.
   *
   * ⚠️ THE DIFFERENCE FROM `tick` MATTERS. Anything counted per tick rather
   * than per player belongs here: the bomb's held time is a property of the
   * bomb, and charging it from the per-player hook would bill the holder once
   * for every seat at the table.
   */
  tickSession?(match: Match, session: PartySession): void;

  /**
   * What a bot does, and when.
   *
   * ⚠️ EVERY GAME NEEDS ONE. Most tables have bots in them, and a bot that
   * cannot play a minigame either stalls the session or loses every single one
   * — which turns Party Mode into "the bots die", the opposite of a party.
   */
  bot(match: Match, session: PartySession, player: PlayerState): void;

  /**
   * What happens to a player who never finished, when the clock runs out.
   *
   * ⚠️ WITHOUT THIS HOOK THE SESSION SIMPLY MARKS THEM LOST, AND FOR SOME GAMES
   * THAT IS WRONG. A blackjack hand with money on the table has to be played
   * out; an unopened chest has to be opened, or "look away" becomes the safe
   * move in the one game that is pure nerve. Games that are happy to be marked
   * lost — the maze, the lock — leave this undefined.
   */
  forceFinish?(match: Match, session: PartySession, player: PlayerState): void;

  /** The result banner, or null when the game's result is "none". */
  result(match: Match, session: PartySession): string | null;

  /**
   * Strips anything the client must not see from a player's data before it goes
   * on the wire. Most games have nothing to hide and omit this.
   */
  sanitizeForWire?(data: Record<string, unknown>): Record<string, unknown>;
}
