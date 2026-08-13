import { evaluate, allDuelPairings, type EvaluationConfig } from "../evaluation/index.js";
import {
  FITNESS_VERSION,
  WEIGHT_PRESETS,
  scoreFitness,
  type FitnessConfig,
  type FitnessResult,
} from "../fitness/index.js";
import { Cmaes } from "./cmaes.js";
import {
  CandidateCache,
  makeCandidate,
  type Candidate,
  type CandidateEvaluation,
  type EvaluationTier,
} from "./candidate.js";
import {
  baseVector,
  buildSchema,
  searchable,
  vectorToParameters,
  type BalanceSchema,
} from "./schema.js";

/**
 * The balance search loop.
 *
 * Screening → full evaluation → validation on disjoint seeds. A full reading
 * costs minutes, so evaluating every candidate at full depth would put a modest
 * run into the tens of hours; most candidates only ever need to be rejected,
 * and screening is how they get rejected cheaply.
 *
 * The optimizer may change the game. It may not change what counts as balanced:
 * fitness weights, thresholds and validation seeds are inputs here, never
 * search dimensions.
 */

export const OPTIMIZER_VERSION = "v1";

export interface TierConfig {
  /** Duel pairings to evaluate; omit for all 120. */
  duelPairings?: number;
  duelSeeds: number;
  ffa4Compositions: number;
  ffa7Compositions: number;
  ffaSeeds: number;
  sampler: string;
}

/** Cheap and deliberately approximate — enough to reject the obviously bad. */
export const SCREEN_TIER: TierConfig = {
  duelPairings: 24,
  duelSeeds: 1,
  ffa4Compositions: 8,
  ffa7Compositions: 6,
  ffaSeeds: 1,
  sampler: "coverage",
};

/** What a candidate must survive to be taken seriously. */
export const FULL_TIER: TierConfig = {
  duelSeeds: 1,
  ffa4Compositions: 24,
  ffa7Compositions: 16,
  ffaSeeds: 1,
  sampler: "stratified",
};

/** Reference depth, on seeds the search never saw. */
export const VALIDATION_TIER: TierConfig = {
  duelSeeds: 3,
  ffa4Compositions: 50,
  ffa7Compositions: 32,
  ffaSeeds: 3,
  sampler: "stratified",
};

export interface SearchConfig {
  schema?: BalanceSchema;
  /** CMA-ES seed. The whole run is reproducible from it. */
  seed?: number;
  generations?: number;
  populationSize?: number;
  sigma?: number;
  workers?: number;
  /** Candidates promoted from screening to full evaluation each generation. */
  promote?: number;
  /** Elites validated at the end of the run. */
  validate?: number;
  fitness?: FitnessConfig;
  onProgress?: (event: ProgressEvent) => void;
  now?: () => string;
}

export interface ProgressEvent {
  kind: "generation" | "candidate";
  generation: number;
  message: string;
}

export interface GenerationRecord {
  generation: number;
  screened: number;
  promoted: number;
  cached: number;
  failed: number;
  bestScreen: number;
  meanScreen: number;
  worstScreen: number;
  bestFull: number | null;
  bestCandidateId: string | null;
  durationMs: number;
}

export interface SearchResult {
  optimizer: string;
  optimizerVersion: string;
  seed: number;
  schema: BalanceSchema;
  baseline: { screen: number | null; full: number | null; validation: number | null };
  generations: GenerationRecord[];
  best: {
    candidate: Candidate;
    screen: number | null;
    full: number | null;
    validation: number | null;
  } | null;
  /** Every full/validation evaluation, for the report. */
  evaluations: CandidateEvaluation[];
  cache: { hits: number; misses: number; size: number };
  totals: { candidates: number; screens: number; fulls: number; validations: number; failures: number; matches: number; durationMs: number };
}

/** Builds the evaluation configuration for a tier. */
function evaluationConfig(
  tier: TierConfig,
  pool: "training" | "validation",
  parameters: Record<string, number> | null,
  id: string,
  workers: number | undefined,
): EvaluationConfig {
  return {
    balanceConfigId: id,
    balance: parameters,
    pool,
    workers,
    duel: {
      enabled: true,
      seedsPerPairing: tier.duelSeeds,
      pairings: tier.duelPairings ? allDuelPairings().slice(0, tier.duelPairings) : undefined,
    },
    ffa4: {
      enabled: true,
      seedsPerPairing: tier.ffaSeeds,
      compositions: tier.ffa4Compositions,
      sampler: tier.sampler,
    },
    ffa7: {
      enabled: true,
      seedsPerPairing: tier.ffaSeeds,
      compositions: tier.ffa7Compositions,
      sampler: tier.sampler,
    },
  };
}

const TIERS: Record<EvaluationTier, TierConfig> = {
  screen: SCREEN_TIER,
  full: FULL_TIER,
  validation: VALIDATION_TIER,
};

/** Evaluates one candidate at one tier, going through the cache. */
async function evaluateCandidate(
  candidate: Candidate,
  tier: EvaluationTier,
  cache: CandidateCache,
  config: SearchConfig,
  fitnessConfig: FitnessConfig,
): Promise<CandidateEvaluation> {
  const cached = cache.get(candidate.hash, tier);
  if (cached) return { ...cached, cached: true };

  // Validation must never touch the pool the search trained on, or an
  // "improvement" is just the optimizer recognising its own dice.
  const pool = tier === "validation" ? "validation" : "training";
  const started = performance.now();
  let evaluation: CandidateEvaluation;
  try {
    const reading = await evaluate(
      evaluationConfig(
        TIERS[tier],
        pool,
        candidate.parameters,
        `${candidate.id}:${tier}`,
        config.workers,
      ),
    );
    evaluation = {
      candidate,
      tier,
      fitness: scoreFitness(reading, fitnessConfig),
      failure: null,
      durationMs: performance.now() - started,
      cached: false,
    };
  } catch (error) {
    // A candidate that crashes the simulator is a result, not a gap: it is
    // recorded, scored at the floor, and never silently skipped.
    evaluation = {
      candidate,
      tier,
      fitness: null,
      failure: (error as Error).message,
      durationMs: performance.now() - started,
      cached: false,
    };
  }
  cache.set(evaluation);
  return evaluation;
}

/** Fitness for ranking; a failed candidate sinks to the bottom deterministically. */
function rankOf(evaluation: CandidateEvaluation): number {
  return evaluation.failure !== null ? -1 : (evaluation.fitness?.overall ?? -1);
}

/** Runs a CMA-ES balance search. */
export async function runSearch(config: SearchConfig = {}): Promise<SearchResult> {
  const schema = config.schema ?? buildSchema();
  const params = searchable(schema);
  const fitnessConfig: FitnessConfig = config.fitness ?? {
    weights: WEIGHT_PRESETS.designerPriority,
    weightsName: "designerPriority",
  };
  const seed = config.seed ?? 20260813;
  const generations = config.generations ?? 10;
  const promote = config.promote ?? 3;
  const validateCount = config.validate ?? 1;

  const cache = new CandidateCache({
    engineSha: "pending",
    fitnessVersion: FITNESS_VERSION,
    schemaVersion: schema.version,
    seedPool: "training",
    samplerVersions: `${SCREEN_TIER.sampler}/${FULL_TIER.sampler}`,
  });

  const started = performance.now();
  const evaluations: CandidateEvaluation[] = [];
  let matches = 0;
  let screens = 0;
  let fulls = 0;
  let validations = 0;
  let failures = 0;

  const record = (e: CandidateEvaluation) => {
    if (e.cached) return;
    if (e.tier === "screen") screens += 1;
    else if (e.tier === "full") fulls += 1;
    else validations += 1;
    if (e.failure) failures += 1;
    matches += e.fitness?.provenance.totalMatches ?? 0;
  };

  // The baseline is evaluated through the same pipeline, so "better than
  // baseline" is a like-for-like comparison rather than an appeal to an
  // earlier run with different settings.
  const baselineCandidate = makeCandidate({
    schema,
    vector: baseVector(schema),
    parameters: {},
    generation: -1,
    index: 0,
    optimizer: "baseline",
  });
  config.onProgress?.({ kind: "generation", generation: -1, message: "evaluating baseline" });
  const baselineScreen = await evaluateCandidate(baselineCandidate, "screen", cache, config, fitnessConfig);
  record(baselineScreen);
  evaluations.push(baselineScreen);
  const baselineFull = await evaluateCandidate(baselineCandidate, "full", cache, config, fitnessConfig);
  record(baselineFull);
  evaluations.push(baselineFull);

  const cma = new Cmaes({
    dimension: params.length,
    mean: baseVector(schema),
    sigma: config.sigma ?? 0.2,
    populationSize: config.populationSize,
    seed,
  });

  const generationRecords: GenerationRecord[] = [];
  let bestFull: CandidateEvaluation | null = null;
  let candidateCount = 0;

  for (let g = 0; g < generations; g++) {
    const genStarted = performance.now();
    const vectors = cma.ask();
    const candidates = vectors.map((vector, index) =>
      makeCandidate({
        schema,
        vector,
        parameters: vectorToParameters(schema, vector),
        generation: g,
        index,
        optimizer: "cmaes",
      }),
    );
    candidateCount += candidates.length;

    // Screen everything cheaply.
    const screened: CandidateEvaluation[] = [];
    for (const candidate of candidates) {
      const e = await evaluateCandidate(candidate, "screen", cache, config, fitnessConfig);
      record(e);
      screened.push(e);
    }

    // CMA-ES learns from the screening scores: they are what every candidate
    // has, and using full scores for some and screening for others would feed
    // the strategy an inconsistent objective.
    cma.tell(vectors, screened.map(rankOf));

    // Promote the best few to a real evaluation.
    const promoted = [...screened]
      .sort((a, b) => rankOf(b) - rankOf(a) || a.candidate.index - b.candidate.index)
      .slice(0, promote);
    let bestFullThisGen: number | null = null;
    for (const p of promoted) {
      if (p.failure) continue;
      const full = await evaluateCandidate(p.candidate, "full", cache, config, fitnessConfig);
      record(full);
      evaluations.push(full);
      const score = rankOf(full);
      if (bestFullThisGen === null || score > bestFullThisGen) bestFullThisGen = score;
      if (!bestFull || score > rankOf(bestFull)) bestFull = full;
    }

    const scores = screened.map(rankOf);
    generationRecords.push({
      generation: g,
      screened: screened.length,
      promoted: promoted.length,
      cached: screened.filter((e) => e.cached).length,
      failed: screened.filter((e) => e.failure).length,
      bestScreen: Math.max(...scores),
      meanScreen: scores.reduce((a, b) => a + b, 0) / scores.length,
      worstScreen: Math.min(...scores),
      bestFull: bestFullThisGen,
      bestCandidateId: bestFull?.candidate.id ?? null,
      durationMs: performance.now() - genStarted,
    });
    config.onProgress?.({
      kind: "generation",
      generation: g,
      message:
        `gen ${g + 1}/${generations}  screen best ${Math.max(...scores).toFixed(4)}  ` +
        `mean ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4)}  ` +
        `full best ${bestFull ? rankOf(bestFull).toFixed(4) : "—"}`,
    });
  }

  // Validate the elite on seeds the search never saw.
  let bestValidation: CandidateEvaluation | null = null;
  let baselineValidation: CandidateEvaluation | null = null;
  if (bestFull && validateCount > 0) {
    config.onProgress?.({ kind: "generation", generation: generations, message: "validating elite on disjoint seeds" });
    baselineValidation = await evaluateCandidate(baselineCandidate, "validation", cache, config, fitnessConfig);
    record(baselineValidation);
    evaluations.push(baselineValidation);
    bestValidation = await evaluateCandidate(bestFull.candidate, "validation", cache, config, fitnessConfig);
    record(bestValidation);
    evaluations.push(bestValidation);
  }

  return {
    optimizer: "cmaes",
    optimizerVersion: OPTIMIZER_VERSION,
    seed,
    schema,
    baseline: {
      screen: rankOf(baselineScreen),
      full: rankOf(baselineFull),
      validation: baselineValidation ? rankOf(baselineValidation) : null,
    },
    generations: generationRecords,
    best: bestFull
      ? {
          candidate: bestFull.candidate,
          screen: cache.get(bestFull.candidate.hash, "screen")?.fitness?.overall ?? null,
          full: rankOf(bestFull),
          validation: bestValidation ? rankOf(bestValidation) : null,
        }
      : null,
    evaluations,
    cache: cache.stats,
    totals: {
      candidates: candidateCount,
      screens, fulls, validations, failures, matches,
      durationMs: performance.now() - started,
    },
  };
}

/** Fitness results keyed for reporting. */
export function fitnessOf(
  result: SearchResult,
  candidateHash: string,
  tier: EvaluationTier,
): FitnessResult | null {
  return (
    result.evaluations.find(
      (e) => e.candidate.hash === candidateHash && e.tier === tier,
    )?.fitness ?? null
  );
}
