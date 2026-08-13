import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import type { KingdomId } from "../../../src/data/kingdoms.js";
import { mulberry32, hashSeed } from "../rng.js";

/**
 * Free-for-all composition sampling.
 *
 * 1v1 needs none of this — all 120 pairings enumerate cheaply. The FFA spaces
 * do: C(16,4) = 1,820 and C(16,7) = 11,440, and evaluating either exhaustively
 * for every candidate is not affordable. This is the abstraction an adaptive
 * sampler plugs into later; for now it ships an exhaustive sampler and a
 * coverage-balanced one.
 */

export interface CompositionSampler {
  /** Stable name, recorded in the reading so a result can be reproduced. */
  readonly name: string;
  /** Chooses `count` compositions of `seats` kingdoms. Must be deterministic
   *  in (seats, count, seed). */
  sample(seats: number, count: number, seed: number): KingdomId[][];
}

/** Every C(n, k) combination, in a stable order. */
export function allCombinations(seats: number): KingdomId[][] {
  const out: KingdomId[][] = [];
  const current: KingdomId[] = [];
  const walk = (start: number): void => {
    if (current.length === seats) {
      out.push([...current]);
      return;
    }
    for (let i = start; i < KINGDOM_IDS.length; i++) {
      current.push(KINGDOM_IDS[i]!);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return out;
}

/** Enumerates the whole space. Affordable for small seat counts and for elite
 *  validation; not for per-candidate evaluation at 7 seats. */
export const exhaustiveSampler: CompositionSampler = {
  name: "exhaustive",
  sample(seats, count) {
    const all = allCombinations(seats);
    return count >= all.length ? all : all.slice(0, count);
  },
};

/**
 * Coverage-balanced sampling.
 *
 * Uniformly random compositions leave some kingdoms materially
 * under-represented at realistic sample sizes, which shows up as a kingdom
 * whose FFA numbers are noise. This repeatedly builds a composition from the
 * kingdoms sampled least so far, breaking ties with the seeded stream, so
 * appearances stay within one of each other while compositions still vary.
 */
export const coverageSampler: CompositionSampler = {
  name: "coverage",
  sample(seats, count, seed) {
    const rng = mulberry32(seed >>> 0);
    const appearances = new Map<KingdomId, number>(
      KINGDOM_IDS.map((k) => [k, 0]),
    );
    const chosen: KingdomId[][] = [];
    const seen = new Set<string>();

    for (let n = 0; n < count; n++) {
      // Rank by appearances so far, jittered so equally-used kingdoms rotate.
      const pool = [...KINGDOM_IDS].sort((a, b) => {
        const d = appearances.get(a)! - appearances.get(b)!;
        return d !== 0 ? d : rng() - 0.5;
      });
      let composition = pool.slice(0, seats).sort();
      // Avoid exact repeats while the space is far larger than the sample.
      let guard = 0;
      while (seen.has(composition.join(",")) && guard < 8) {
        const shuffled = [...pool];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        composition = shuffled.slice(0, seats).sort();
        guard++;
      }
      seen.add(composition.join(","));
      for (const k of composition) appearances.set(k, appearances.get(k)! + 1);
      chosen.push(composition);
    }
    return chosen;
  },
};

export const SAMPLERS: Record<string, CompositionSampler> = {
  exhaustive: exhaustiveSampler,
  coverage: coverageSampler,
};

/** Per-kingdom appearance counts for a sampled set — reported so coverage is
 *  visible rather than assumed. */
export function coverageOf(
  compositions: readonly KingdomId[][],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const k of KINGDOM_IDS) counts[k] = 0;
  for (const c of compositions) for (const k of c) counts[k] = (counts[k] ?? 0) + 1;
  return counts;
}

/** Deterministic seed for a sampler from the pool and format. */
export function samplerSeed(pool: string, seats: number): number {
  return hashSeed(`sampler:${pool}:${seats}`);
}
