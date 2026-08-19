/**
 * The production bot subsystem.
 *
 * Ported from the training simulator, which is the reference implementation.
 * The heuristic personalities are deliberately NOT ported: they exist there as
 * training benchmarks and have no place in the shipped game.
 */
export { ACTION_SIZE, PRIMARY_ACTION_COUNT, WAIT, orderEnemies, primaryActionOf, type PrimaryAction } from "./actions.js";
export { NetworkController, networkAI, type ControllerStats, type NetworkControllerOptions } from "./controller.js";
export { chargesToSpend, decide, type Decision } from "./decode.js";
export { DEFAULT_DECISION_PERIOD, DIFFICULTY, type Difficulty, type DifficultyConfig } from "./difficulty.js";
export { ObservedHistory, knowledgeFor, type PlayerKnowledge } from "./knowledge.js";
export { createMask, legalActions, type ActionMask } from "./legality.js";
export { assertModelCompatible, type AiModel } from "./model.js";
export { MODEL_FORMAT_VERSION } from "./versions.js";
export { randomNetwork, type Network } from "./network.js";
export { OBSERVATION_SIZE, encode, observationSpecHash } from "./observation.js";
export { ACTION_VERSION, GENOME_VERSION, OBSERVATION_VERSION } from "./versions.js";
export { visibilitySpecHash } from "./visibility.js";
export { mulberry32, type AIContext, type AIController, type AIFactory, type Rng } from "./runtime.js";
