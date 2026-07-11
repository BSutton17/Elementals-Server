import { GameLoop } from "./GameLoop.js";
import { tickMatch } from "./tick.js";
import type { Match } from "../match/Match.js";
import type { MatchManager } from "../match/MatchManager.js";
import { TICK } from "../data/balance.js";

export interface GameLoopManagerOptions {
  /** Called every `syncEveryTicks` ticks to push game state to clients (#49). */
  sync?: (match: Match) => void;
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

  constructor(
    private readonly matches: MatchManager,
    private readonly options: GameLoopManagerOptions = {},
  ) {}

  start(match: Match): void {
    if (this.loops.has(match.roomCode)) return;

    const tickRate = match.config?.tickRate ?? TICK.RATE;
    const syncEvery = this.options.syncEveryTicks ?? TICK.SYNC_EVERY_TICKS;

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
          this.stop(match.roomCode);
          this.options.onEnd?.(live);
          return;
        }

        if (this.options.sync && tick % syncEvery === 0) {
          this.options.sync(live);
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
  }

  get activeCount(): number {
    return this.loops.size;
  }
}
