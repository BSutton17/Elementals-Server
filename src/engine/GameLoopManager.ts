import { GameLoop } from "./GameLoop.js";
import { tickMatch } from "./tick.js";
import type { Match } from "../match/Match.js";
import type { MatchManager } from "../match/MatchManager.js";
import type { GameplayEvent } from "./events.js";
import { TICK } from "../data/balance.js";

export interface GameLoopManagerOptions {
  /** Called every `syncEveryTicks` ticks to push game state to clients (#49). */
  sync?: (match: Match) => void;
  /** Called with the gameplay events buffered since the last flush, on the sync
   *  cadence and once more at match end (Epic 9 VFX transport). Subscribing
   *  turns the EventBus on for the live match. */
  syncEvents?: (match: Match, events: GameplayEvent[]) => void;
  /** Called once when a match ends, to broadcast the result (#50). */
  onEnd?: (match: Match) => void;
  /** Sync cadence (defaults to the balance value). */
  syncEveryTicks?: number;
}

/**
 * Runs one authoritative game loop per active match. A loop self-stops once the
 * match no longer exists, is no longer active, or has ended — so no external
 * cleanup is required.
 */
export class GameLoopManager {
  private readonly loops = new Map<string, GameLoop>();
  /** Per-match VFX event buffer + its EventBus unsubscribe. */
  private readonly eventSubs = new Map<
    string,
    { buffer: GameplayEvent[]; unsubscribe: () => void }
  >();

  constructor(
    private readonly matches: MatchManager,
    private readonly options: GameLoopManagerOptions = {},
  ) {}

  start(match: Match): void {
    if (this.loops.has(match.roomCode)) return;

    const tickRate = match.config?.tickRate ?? TICK.RATE;
    const syncEvery = this.options.syncEveryTicks ?? TICK.SYNC_EVERY_TICKS;

    // Subscribe to the match's EventBus so gameplay events can be forwarded to
    // clients (Epic 9). Only when a consumer is wired — otherwise the bus stays
    // off and producers pay nothing.
    if (this.options.syncEvents && match.gameState) {
      const buffer: GameplayEvent[] = [];
      const unsubscribe = match.gameState.events.on((event) => buffer.push(event));
      this.eventSubs.set(match.roomCode, { buffer, unsubscribe });
    }

    const flushEvents = (live: Match): void => {
      const sub = this.eventSubs.get(match.roomCode);
      if (sub && sub.buffer.length > 0 && this.options.syncEvents) {
        this.options.syncEvents(live, sub.buffer.slice());
        sub.buffer.length = 0;
      }
    };

    const loop = new GameLoop({
      tickRate,
      onTick: (tick) => {
        const live = this.matches.getMatch(match.roomCode);
        if (!live || live.phase !== "active") {
          this.stop(match.roomCode);
          return;
        }

        // The tick may end the match (last kingdom standing).
        const ended = tickMatch(live, tick);
        if (ended) {
          flushEvents(live); // deliver the finishing blow / elimination VFX
          this.stop(match.roomCode);
          this.options.onEnd?.(live);
          return;
        }

        if (tick % syncEvery === 0) {
          this.options.sync?.(live);
          flushEvents(live);
        }
      },
    });
    loop.start();
    this.loops.set(match.roomCode, loop);
  }

  stop(roomCode: string): void {
    const loop = this.loops.get(roomCode);
    if (loop) {
      loop.stop();
      this.loops.delete(roomCode);
    }
    const sub = this.eventSubs.get(roomCode);
    if (sub) {
      sub.unsubscribe();
      this.eventSubs.delete(roomCode);
    }
  }

  get activeCount(): number {
    return this.loops.size;
  }
}
