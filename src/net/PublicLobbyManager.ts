import type { Match } from "../match/Match.js";
import type { MatchManager } from "../match/MatchManager.js";
import { MATCH } from "../data/balance.js";

/**
 * The timers a public lobby runs on: the countdown to launch, and the reaper
 * that clears rooms nobody is left in.
 *
 * A private room needs neither. It starts when its host presses the button and
 * it exists as long as the people who share the code want it to. A matchmade
 * room has no host to press anything and no one with a reason to tidy it up, so
 * both jobs move to the server.
 *
 * ⚠️ DEADLINES ARE ABSOLUTE, NOT DURATIONS. Everything here works in wall-clock
 * timestamps and broadcasts them as such. Sending "18 seconds remaining" makes
 * every client's countdown drift by its own latency and they end up disagreeing
 * about when the match begins; one timestamp is the same instant for everyone.
 */

/** Seconds the first arrival waits on their own. */
export const FIRST_JOIN_SECONDS = 30;
/** Added for each further human who joins, so a filling room stays open. */
export const PER_JOIN_SECONDS = 15;
/** How long a searcher waits for an existing room before opening one. */
export const SEARCH_SECONDS = 15;
/** How long a room with nobody in it is kept before being closed. */
export const EMPTY_ROOM_SECONDS = 10;

export interface PublicLobbyHooks {
  /** Launch this room now: seat the stragglers, fill with bots, go. */
  startMatch(match: Match): void;
  /** Push the room's state (including the new deadline) to its members. */
  broadcast(match: Match): void;
  /** Tear the room down — nobody is coming back. */
  closeRoom(roomCode: string): void;
}

export class PublicLobbyManager {
  private readonly countdowns = new Map<string, NodeJS.Timeout>();
  private readonly reapers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly matches: MatchManager,
    private readonly hooks: PublicLobbyHooks,
  ) {}

  /**
   * A human joined a public room: extend (or open) its countdown.
   *
   * The first arrival gets the full wait so a room is not created and launched
   * before anyone else can find it. Every later arrival ADDS time rather than
   * resetting it — a room that keeps filling stays open a little longer for the
   * next person, but the total is still bounded by the seat cap below.
   */
  onHumanJoined(match: Match): void {
    if (match.visibility !== "public" || match.phase !== "lobby") return;

    // A full room has nothing left to wait for.
    if (match.activePlayerCount >= MATCH.MAX_ACTIVE_PLAYERS) {
      this.launch(match);
      return;
    }

    const now = Date.now();
    const base = match.startsAt !== null && match.startsAt > now ? match.startsAt : now;
    const added = match.startsAt === null ? FIRST_JOIN_SECONDS : PER_JOIN_SECONDS;
    match.startsAt = base + added * 1000;
    this.arm(match);
    this.hooks.broadcast(match);
  }

  /** Schedules the launch for whatever `startsAt` currently says. */
  private arm(match: Match): void {
    this.clearCountdown(match.roomCode);
    if (match.startsAt === null) return;
    const timer = setTimeout(
      () => {
        this.countdowns.delete(match.roomCode);
        // Re-read: the room may have emptied or started while this was pending.
        const live = this.matches.getMatch(match.roomCode);
        if (live && live.phase === "lobby") this.launch(live);
      },
      Math.max(0, match.startsAt - Date.now()),
    );
    timer.unref?.();
    this.countdowns.set(match.roomCode, timer);
  }

  private launch(match: Match): void {
    this.clearCountdown(match.roomCode);
    match.startsAt = null;
    this.hooks.startMatch(match);
  }

  /**
   * Called whenever a room's roster changes.
   *
   * ⚠️ COUNTS PEOPLE, NOT SEATS. A room auto-filled with bots is never empty by
   * player count, so a bot-only room would sit on the server forever and — far
   * worse — matchmaking would keep offering it to real players who then find
   * themselves alone with seven bots.
   */
  onRosterChanged(match: Match): void {
    if (match.humanCount() > 0) {
      this.clearReaper(match.roomCode);
      return;
    }
    if (this.reapers.has(match.roomCode)) return;
    const timer = setTimeout(() => {
      this.reapers.delete(match.roomCode);
      const live = this.matches.getMatch(match.roomCode);
      // Someone may have reconnected inside the grace window.
      if (!live || live.humanCount() > 0) return;
      this.clearCountdown(live.roomCode);
      this.hooks.closeRoom(live.roomCode);
    }, EMPTY_ROOM_SECONDS * 1000);
    timer.unref?.();
    this.reapers.set(match.roomCode, timer);
  }

  /**
   * An open public room a searcher may be seated in, or null.
   *
   * Deliberately picks the FULLEST joinable room rather than the emptiest: it
   * gets people into a game that is about to start instead of spreading them
   * one-per-room across several lobbies that each then wait a full thirty
   * seconds.
   */
  findOpenRoom(): Match | null {
    const open = this.matches
      .getMatches()
      .filter(
        (m) =>
          m.visibility === "public" &&
          m.phase === "lobby" &&
          m.connectedHumanCount() > 0 &&
          m.activePlayerCount < MATCH.MAX_ACTIVE_PLAYERS,
      )
      .sort((a, b) => b.activePlayerCount - a.activePlayerCount);
    return open[0] ?? null;
  }

  /** Stops every timer for a room, whatever state it was in. */
  forget(roomCode: string): void {
    this.clearCountdown(roomCode);
    this.clearReaper(roomCode);
  }

  private clearCountdown(roomCode: string): void {
    const timer = this.countdowns.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      this.countdowns.delete(roomCode);
    }
  }

  private clearReaper(roomCode: string): void {
    const timer = this.reapers.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      this.reapers.delete(roomCode);
    }
  }

  /** Cancels everything. For tests and shutdown. */
  clear(): void {
    for (const t of this.countdowns.values()) clearTimeout(t);
    for (const t of this.reapers.values()) clearTimeout(t);
    this.countdowns.clear();
    this.reapers.clear();
  }
}
