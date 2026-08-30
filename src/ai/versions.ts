/**
 * Version identity for the AI runtime.
 *
 * The repository already has a settled convention for this — a version
 * constant, an identity struct, and a comparison that refuses and NAMES the
 * field that differs (`evaluation/provenance.ts`, `search/checkpoint.ts`,
 * `distributed/protocol.ts`). This module supplies the constants; `model.ts`
 * supplies the identity and the refusal.
 *
 * Why these are separate constants rather than one "AI version": a trained
 * network is a set of weights on SPECIFIC input and output indices. Changing
 * what input 31 means does not make an old model worse, it makes it a different
 * function reading the same 64 numbers — and it will play confidently and
 * wrongly, with nothing raising an error. Each constant therefore guards one
 * thing that can silently invalidate a model.
 */

/** The `AiModel` envelope shape (model.ts). */
export const MODEL_FORMAT_VERSION = 1;

/**
 * The observation contract: the inputs, their order, their normalization, AND
 * the visibility table that decides which of them are gated.
 *
 * Bump when any of those change. A test pins this against the observation
 * specification hash so the two cannot drift apart silently.
 *
 * ⚠️ v4 WAS ROLLED BACK TO v3, DELIBERATELY, AND THIS IS NOT A DOWNGRADE BY
 * ACCIDENT. v4 added four monster inputs (87–90), taking the vector to 91.
 * Every champion trained against it opened passively — first kingdom target
 * 204–371 s in, one seat never — while the v3 networks do not do that. The
 * vector is therefore back to the exact 87 those networks were trained on so
 * they can be shipped again while that is fixed.
 *
 * The number is v3 rather than a new v5 because the CONTRACT IS BYTE-IDENTICAL
 * to v3: same 87 indices, same order, same normalizations. `field.monster`
 * exists in `knowledge.ts` and in the visibility table, but it is not encoded,
 * so nothing a v3 network reads has changed. A model must be refused when what
 * it reads differs, and here it does not.
 */
export const OBSERVATION_VERSION = "v3";

/**
 * The action contract: the 22 outputs, their order, and the target ordering
 * rule. The ordering is part of this version because outputs 14–19 are
 * meaningless without it.
 */
export const ACTION_VERSION = "v3";

/**
 * The genome/network serialization shape. Declared now, unused until Phase 2 —
 * a model written today must already say which genome format it is in.
 */
export const GENOME_VERSION = "v1";
