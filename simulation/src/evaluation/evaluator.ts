import { withParameterSet } from "../../../src/engine/parameters.js";
import type { ParameterSet } from "../../../src/engine/parameters.js";
import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import type { KingdomId } from "../../../src/data/kingdoms.js";
import { runHeadlessMatch } from "../headless.js";
import type { MatchRecord } from "../types.js";
import {
  POPULATION_V1,
  factoryFor,
  orderedPairings,
  seatProfiles,
  type ProfilePairing,
  type StrategyPopulation,
} from "./population.js";
import { seedsFor, type SeedPoolName } from "./seeds.js";
import { captureProvenance, type Provenance } from "./provenance.js";
import {
  SAMPLERS,
  coverageOf,
  samplerSeed,
  type CompositionSampler,
} from "./samplers.js";
import {
  placementStats,
  pool,
  rate,
  spreadOf,
  type PlacementStats,
  type Rate,
  type Spread,
} from "./stats.js";

/**
 * The balance evaluation system.
 *
 * Answers one question: given this engine and this balance configuration, how
 * balanced is the game? It measures; it does not judge. No threshold here
 * declares a kingdom overpowered — that is the future fitness function's job,
 * and conflating the two is how a measuring instrument acquires opinions.
 *
 * The central rule, from Step 3: a reading is always taken over a POPULATION of
 * strategies across ordered pairings, never a single personality.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FormatConfig {
  enabled: boolean;
  /** Seeds per (composition × ordered strategy pairing). */
  seedsPerPairing: number;
  /** FFA only: how many compositions to sample. */
  compositions?: number;
  /** FFA only: sampler name (see SAMPLERS). */
  sampler?: string;
}

export interface EvaluationConfig {
  /** Name for the configuration under test (free text, recorded). */
  balanceConfigId?: string;
  /** Overrides to evaluate under; omit for the production baseline. */
  balance?: ParameterSet | null;
  pool?: SeedPoolName;
  population?: StrategyPopulation;
  /** Per-match tick cap. */
  maxTicks?: number;
  duel?: Partial<FormatConfig> & {
    /** Restrict to these pairings; omit for all 120. */
    pairings?: [KingdomId, KingdomId][];
  };
  ffa4?: Partial<FormatConfig>;
  ffa7?: Partial<FormatConfig>;
  /** Progress callback; receives completed matches and the total planned. */
  onProgress?: (done: number, total: number) => void;
  /** Injected clock, so reproducibility tests can pin the timestamp. */
  now?: () => string;
}

const DEFAULT_DUEL: FormatConfig = { enabled: true, seedsPerPairing: 1 };
const DEFAULT_FFA4: FormatConfig = {
  enabled: true,
  seedsPerPairing: 1,
  compositions: 24,
  sampler: "coverage",
};
const DEFAULT_FFA7: FormatConfig = {
  enabled: true,
  seedsPerPairing: 1,
  compositions: 16,
  sampler: "coverage",
};

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** One cell of the duel matrix: kingdom A's results against kingdom B. */
export interface MatchupResult {
  a: KingdomId;
  b: KingdomId;
  /** A's win rate pooled over every ordered strategy pairing. THE number. */
  aggregate: Rate;
  /** Per-ordered-pairing win rate, keyed "profileA/profileB". Diagnostic. */
  byPairing: Record<string, Rate>;
  /** How much the result moves with strategy — diagnostic, never a fitness
   *  input. A wide spread means the matchup is strategy-sensitive, which is
   *  information about the game, not necessarily a defect. */
  profileSpread: Spread;
  /** Matches that hit the tick cap without a winner. */
  timeouts: number;
  meanTicks: number;
}

export interface DuelResults {
  pairings: number;
  matches: number;
  /** Every evaluated matchup, ordered a<b. */
  matchups: MatchupResult[];
  /** Per-kingdom win rate pooled across all its matchups. */
  kingdoms: Record<string, Rate>;
  /** Per-strategy win rate pooled across every matchup it played. */
  profiles: Record<string, Rate>;
  /** Mirror pairings (same profile both seats) — seat-0 win rate. Diagnostic
   *  for controller-induced asymmetry; 0.5 is neutral. */
  mirrors: Record<string, Rate>;
}

export interface FfaKingdomResult {
  kingdom: KingdomId;
  placement: PlacementStats;
}

export interface FfaResults {
  seats: number;
  sampler: string;
  compositions: KingdomId[][];
  /** Per-kingdom appearances across the sample. */
  coverage: Record<string, number>;
  matches: number;
  timeouts: number;
  meanTicks: number;
  kingdoms: Record<string, FfaKingdomResult>;
  /** Per-strategy first-place rate across the sample. */
  profiles: Record<string, Rate>;
}

export interface EvaluationResult {
  provenance: Provenance;
  pool: SeedPoolName;
  population: { version: string; profiles: string[] };
  totals: { matches: number; ticks: number; timeouts: number; durationMs: number };
  duel: DuelResults | null;
  ffa4: FfaResults | null;
  ffa7: FfaResults | null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** All C(16,2) = 120 unordered kingdom pairings. */
export function allDuelPairings(): [KingdomId, KingdomId][] {
  const out: [KingdomId, KingdomId][] = [];
  for (let i = 0; i < KINGDOM_IDS.length; i++) {
    for (let j = i + 1; j < KINGDOM_IDS.length; j++) {
      out.push([KINGDOM_IDS[i]!, KINGDOM_IDS[j]!]);
    }
  }
  return out;
}

/** Placement per player id: winner 1, then reverse death order, survivors of a
 *  timeout ranked by remaining HP. Mirrors the analytics convention. */
function placements(record: MatchRecord): Map<string, number> {
  const order = [...record.players].sort((x, y) => {
    if (x.id === record.winnerId) return -1;
    if (y.id === record.winnerId) return 1;
    const xd = x.eliminatedAtTick;
    const yd = y.eliminatedAtTick;
    if (xd === null && yd === null) return y.hp - x.hp;
    if (xd === null) return -1;
    if (yd === null) return 1;
    return yd - xd;
  });
  return new Map(order.map((p, i) => [p.id, i + 1]));
}

/** Runs one match and returns its record. */
function runOne(
  kingdoms: KingdomId[],
  profiles: string[],
  population: StrategyPopulation,
  seed: number,
  maxTicks: number,
): MatchRecord {
  return runHeadlessMatch({
    players: kingdoms.map((kingdomId, i) => ({
      kingdomId,
      ai: factoryFor(population, profiles[i]!),
    })),
    seed,
    maxTicks,
    createAI: factoryFor(population, profiles[0]!),
    telemetry: false,
  });
}

/**
 * Evaluates a balance configuration and returns a reading.
 *
 * The whole evaluation runs inside one `withParameterSet` scope, so production
 * data is never mutated and overrides cannot leak into a neighbouring run.
 */
export function evaluate(config: EvaluationConfig = {}): EvaluationResult {
  const population = config.population ?? POPULATION_V1;
  const seedPool = config.pool ?? "validation";
  const maxTicks = config.maxTicks ?? 24_000;
  const duelCfg = { ...DEFAULT_DUEL, ...config.duel };
  const ffa4Cfg = { ...DEFAULT_FFA4, ...config.ffa4 };
  const ffa7Cfg = { ...DEFAULT_FFA7, ...config.ffa7 };
  const pairings = orderedPairings(population);

  const provenance = captureProvenance({
    balanceConfigId: config.balanceConfigId ?? "baseline",
    balance: config.balance,
    strategyPopulationVersion: population.version,
    now: config.now,
  });

  // Plan the work up front so progress is meaningful.
  const duelList = duelCfg.pairings ?? allDuelPairings();
  const ffa4Sampler = pickSampler(ffa4Cfg.sampler);
  const ffa7Sampler = pickSampler(ffa7Cfg.sampler);
  const ffa4Comps = ffa4Cfg.enabled
    ? ffa4Sampler.sample(4, ffa4Cfg.compositions ?? 0, samplerSeed(seedPool, 4))
    : [];
  const ffa7Comps = ffa7Cfg.enabled
    ? ffa7Sampler.sample(7, ffa7Cfg.compositions ?? 0, samplerSeed(seedPool, 7))
    : [];
  const total =
    (duelCfg.enabled ? duelList.length * pairings.length * duelCfg.seedsPerPairing : 0) +
    ffa4Comps.length * pairings.length * ffa4Cfg.seedsPerPairing +
    ffa7Comps.length * pairings.length * ffa7Cfg.seedsPerPairing;

  let done = 0;
  let ticks = 0;
  let timeouts = 0;
  const tick = (record: MatchRecord): void => {
    done += 1;
    ticks += record.endedAtTick;
    if (record.timedOut) timeouts += 1;
    if (config.onProgress && done % 200 === 0) config.onProgress(done, total);
  };

  const startedAt = performance.now();
  const result = withParameterSet(config.balance ?? null, () => {
    const duel = duelCfg.enabled
      ? evaluateDuels(duelList, pairings, population, seedPool, duelCfg, maxTicks, tick)
      : null;
    const ffa4 = ffa4Cfg.enabled
      ? evaluateFfa(4, ffa4Comps, ffa4Sampler.name, pairings, population, seedPool, ffa4Cfg, maxTicks, tick)
      : null;
    const ffa7 = ffa7Cfg.enabled
      ? evaluateFfa(7, ffa7Comps, ffa7Sampler.name, pairings, population, seedPool, ffa7Cfg, maxTicks, tick)
      : null;
    return { duel, ffa4, ffa7 };
  });

  config.onProgress?.(done, total);
  return {
    provenance,
    pool: seedPool,
    population: { version: population.version, profiles: population.profiles.map((p) => p.id) },
    totals: {
      matches: done,
      ticks,
      timeouts,
      durationMs: performance.now() - startedAt,
    },
    ...result,
  };
}

function pickSampler(name: string | undefined): CompositionSampler {
  const sampler = SAMPLERS[name ?? "coverage"];
  if (!sampler) throw new Error(`unknown sampler "${name}"`);
  return sampler;
}

function evaluateDuels(
  duelList: [KingdomId, KingdomId][],
  pairings: ProfilePairing[],
  population: StrategyPopulation,
  seedPool: SeedPoolName,
  cfg: FormatConfig,
  maxTicks: number,
  tick: (r: MatchRecord) => void,
): DuelResults {
  const matchups: MatchupResult[] = [];
  const kingdomWins = new Map<string, { w: number; n: number }>();
  const profileWins = new Map<string, { w: number; n: number }>();
  const mirrorWins = new Map<string, { w: number; n: number }>();
  let matches = 0;

  const bump = (m: Map<string, { w: number; n: number }>, key: string, won: boolean) => {
    const e = m.get(key) ?? { w: 0, n: 0 };
    e.n += 1;
    if (won) e.w += 1;
    m.set(key, e);
  };

  for (const [a, b] of duelList) {
    const label = `${a}-vs-${b}`;
    const byPairing: Record<string, Rate> = {};
    const perPairingRates: number[] = [];
    let aWins = 0;
    let n = 0;
    let mTimeouts = 0;
    let mTicks = 0;

    for (const pairing of pairings) {
      const seeds = seedsFor(seedPool, label, pairing.key, cfg.seedsPerPairing);
      let pairWins = 0;
      for (const seed of seeds) {
        const record = runOne([a, b], seatProfiles(pairing, 2), population, seed, maxTicks);
        tick(record);
        matches += 1;
        n += 1;
        mTicks += record.endedAtTick;
        if (record.timedOut) mTimeouts += 1;
        const aWon = record.winnerKingdom === a;
        if (aWon) {
          aWins += 1;
          pairWins += 1;
        }
        // Kingdom + strategy aggregates. A win credits the kingdom and the
        // strategy that was driving it.
        bump(kingdomWins, a, aWon);
        bump(kingdomWins, b, record.winnerKingdom === b);
        bump(profileWins, pairing.a, aWon);
        bump(profileWins, pairing.b, record.winnerKingdom === b);
        if (pairing.mirror) bump(mirrorWins, pairing.a, record.winnerId === "p0");
      }
      const r = rate(pairWins, seeds.length);
      byPairing[pairing.key] = r;
      perPairingRates.push(r.rate);
    }

    matchups.push({
      a,
      b,
      aggregate: rate(aWins, n),
      byPairing,
      profileSpread: spreadOf(perPairingRates),
      timeouts: mTimeouts,
      meanTicks: n > 0 ? mTicks / n : 0,
    });
  }

  return {
    pairings: duelList.length,
    matches,
    matchups,
    kingdoms: toRates(kingdomWins),
    profiles: toRates(profileWins),
    mirrors: toRates(mirrorWins),
  };
}

function evaluateFfa(
  seats: number,
  compositions: KingdomId[][],
  samplerName: string,
  pairings: ProfilePairing[],
  population: StrategyPopulation,
  seedPool: SeedPoolName,
  cfg: FormatConfig,
  maxTicks: number,
  tick: (r: MatchRecord) => void,
): FfaResults {
  const byKingdom = new Map<string, number[]>();
  const profileFirsts = new Map<string, { w: number; n: number }>();
  let matches = 0;
  let timeouts = 0;
  let ticks = 0;

  for (const composition of compositions) {
    const label = composition.join("+");
    for (const pairing of pairings) {
      const seeds = seedsFor(seedPool, label, pairing.key, cfg.seedsPerPairing);
      const profiles = seatProfiles(pairing, seats);
      for (const seed of seeds) {
        // Rotate the roster by match index so no kingdom is pinned to a seat:
        // seat order drives intent resolution, targeting and RNG streams.
        const rotation = matches % seats;
        const rotated = composition.map((_, i) => composition[(i + rotation) % seats]!);
        const record = runOne(rotated, profiles, population, seed, maxTicks);
        tick(record);
        matches += 1;
        ticks += record.endedAtTick;
        if (record.timedOut) timeouts += 1;

        const place = placements(record);
        for (const p of record.players) {
          if (!p.kingdomId) continue;
          const list = byKingdom.get(p.kingdomId) ?? [];
          list.push(place.get(p.id)!);
          byKingdom.set(p.kingdomId, list);
        }
        // Credit the first place to the strategy that was driving that seat.
        const winner = record.players.find((p) => p.id === record.winnerId);
        for (let i = 0; i < profiles.length; i++) {
          const id = profiles[i]!;
          const e = profileFirsts.get(id) ?? { w: 0, n: 0 };
          e.n += 1;
          if (winner && record.players[i]?.id === winner.id) e.w += 1;
          profileFirsts.set(id, e);
        }
      }
    }
  }

  const kingdoms: Record<string, FfaKingdomResult> = {};
  for (const [kingdom, list] of byKingdom) {
    kingdoms[kingdom] = {
      kingdom: kingdom as KingdomId,
      placement: placementStats(list, seats),
    };
  }

  return {
    seats,
    sampler: samplerName,
    compositions,
    coverage: coverageOf(compositions),
    matches,
    timeouts,
    meanTicks: matches > 0 ? ticks / matches : 0,
    kingdoms,
    profiles: toRates(profileFirsts),
  };
}

function toRates(m: Map<string, { w: number; n: number }>): Record<string, Rate> {
  const out: Record<string, Rate> = {};
  for (const [k, v] of [...m].sort(([a], [b]) => a.localeCompare(b))) {
    out[k] = rate(v.w, v.n);
  }
  return out;
}

/** Pools a set of matchup aggregates — used by reporting and comparison. */
export function poolMatchups(matchups: readonly MatchupResult[]): Rate {
  return pool(matchups.map((m) => m.aggregate));
}
