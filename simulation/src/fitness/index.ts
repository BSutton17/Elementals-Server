/**
 * Balance fitness — the bridge between evaluation results and the Balance AI.
 *
 * The evaluator measures and refuses to judge. This is where judgement lives,
 * and deliberately the only place: every threshold, weight and fairness target
 * is declared here, versioned, and recorded in the output, so a score can
 * always be traced back to the measurement that produced it.
 */
export {
  scoreFitness,
  compareFitness,
  FITNESS_VERSION,
  WEIGHT_PRESETS,
  type FitnessConfig,
  type FitnessResult,
  type FitnessComparison,
  type FormatFitness,
  type FormatWeights,
  type ComponentScore,
  type ConstraintViolation,
  type FitnessDiagnostics,
  type FitnessProvenance,
  type DeadBands,
  type ComponentWeights,
  type Constraints,
} from "./fitness.js";

export {
  normalisedDeviation,
  penalise,
  fairnessFrom,
  distributionDivergence,
  weightedMean,
  clamp01,
  type Fairness,
} from "./metrics.js";

export { syntheticEvaluation, type SyntheticSpec } from "./scenarios.js";
export { fitnessText, fitnessComparisonText } from "./report.js";
