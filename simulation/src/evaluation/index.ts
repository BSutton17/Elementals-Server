/**
 * Balance evaluation system — the measuring instrument the Balance AI will sit
 * on top of.
 *
 * It answers exactly one question: given this engine and this balance
 * configuration, how balanced is the game? It reports; it never judges, and it
 * never modifies production data.
 *
 * The rule it exists to enforce (established in Step 3): a reading is taken
 * over a POPULATION of strategies across ordered pairings. A single AI
 * personality is deterministic enough that its win rate is a boolean rather
 * than a probability, and it flips wholesale when the personality changes.
 */

export {
  evaluate,
  allDuelPairings,
  poolMatchups,
  type EvaluationConfig,
  type EvaluationResult,
  type DuelResults,
  type FfaResults,
  type FfaKingdomResult,
  type MatchupResult,
  type FormatConfig,
} from "./evaluator.js";

export {
  POPULATION_V1,
  orderedPairings,
  factoryFor,
  seatProfiles,
  type StrategyPopulation,
  type StrategyProfile,
  type ProfilePairing,
} from "./population.js";

export {
  SEED_POOLS,
  seedFor,
  seedsFor,
  poolsDisjoint,
  type SeedPoolName,
} from "./seeds.js";

export {
  captureProvenance,
  comparabilityKey,
  comparabilityProblem,
  hashBaseline,
  hashParameterSet,
  EVALUATION_FORMAT_VERSION,
  type Provenance,
} from "./provenance.js";

export {
  SAMPLERS,
  allCombinations,
  coverageOf,
  coverageSampler,
  exhaustiveSampler,
  samplerSeed,
  type CompositionSampler,
} from "./samplers.js";

export {
  rate,
  pool,
  wilson,
  spreadOf,
  placementStats,
  uncertainty,
  type Rate,
  type Spread,
  type PlacementStats,
} from "./stats.js";

export { compare, type Comparison, type Delta, type MatchupDelta } from "./compare.js";
export { toJson, reportText, comparisonText, matrixText } from "./report.js";
