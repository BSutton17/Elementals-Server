import type { Match } from "../match/Match.js";
import type { PlayerState } from "../match/playerState.js";

/**
 * The small runtime contract the bot controller needs.
 *
 * Duplicated from the simulation repository rather than imported, and the reason
 * is a dependency boundary rather than laziness: the simulator is a downstream
 * consumer of THIS repository's engine, so a production import of a simulation
 * module would invert the dependency and make the game depend on its own test
 * harness. These four declarations are the entire surface, and they are pinned
 * against drift by `test/botRuntime.test.ts`.
 */

/** A deterministic random stream. Same seed, same sequence, always. */
export type Rng = () => number;

/**
 * mulberry32 — small, fast, well-distributed. Identical to the simulator's, so a
 * bot seeded the same way makes the same decisions in both places, which is what
 * makes a training result predictive of live behaviour.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What a controller sees when it acts.
 *
 * It receives the live match, but only `knowledge.ts` is permitted to read it,
 * and only through the visibility table. Everything else in this subsystem works
 * from the projection that produces — which is what keeps a bot's information
 * identical to a human's in the same seat.
 */
export interface AIContext {
  match: Match;
  player: PlayerState;
  /** The tick about to run. Intents drain before the tick — see GAME_TICK.md. */
  tick: number;
  rng: Rng;
}

/** A controller drives one seat for the duration of one match. */
export interface AIController {
  /** Called once per tick, before the tick advances. */
  act(ctx: AIContext): void;
}

/** Builds a controller for one seat; called once per match. */
export type AIFactory = (player: PlayerState, rng: Rng) => AIController;
