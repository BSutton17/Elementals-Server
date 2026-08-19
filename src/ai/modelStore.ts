import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertModelCompatible, type AiModel } from "./model.js";
import type { Difficulty } from "./difficulty.js";
import { buildNetwork } from "./phenotype.js";
import type { Network } from "./network.js";

/**
 * Loads the trained models the bots play with.
 *
 * Weights live in JSON on disk, never in TypeScript. A genome is ~500 connections
 * of tuned floats — checking that into source would make every retrain a code
 * change, hide the diff, and tempt someone to "fix" a weight by hand.
 *
 * REFUSES rather than degrades. A model whose observation or action schema does
 * not match this build is not merely suboptimal, it is meaningless: input 37
 * would be read as something it was never trained on, and the bot would play
 * confidently and wrongly. `assertModelCompatible` names the differing field.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where models are looked for, first match wins. Overridable for tests/deploys. */
export function modelSearchPaths(): string[] {
  const fromEnv = process.env.ELEMENTALS_AI_MODEL_DIR;
  return [
    ...(fromEnv ? [resolve(fromEnv)] : []),
    resolve(HERE, "../../models"),
    resolve(HERE, "../../../models"),
  ];
}

export function modelPath(difficulty: Difficulty): string | null {
  for (const dir of modelSearchPaths()) {
    const candidate = join(dir, `${difficulty}.json`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface LoadedModel {
  readonly difficulty: Difficulty;
  readonly model: AiModel;
  readonly network: Network;
  readonly path: string;
}

const cache = new Map<Difficulty, LoadedModel>();

/**
 * Loads one difficulty, compiling the network once and reusing it.
 *
 * A compiled network is READ-ONLY at run time — `activate` writes only into the
 * caller's output buffer — so one instance is safely shared by every bot seat in
 * every concurrent match. That matters: a busy server may hold dozens of bots,
 * and recompiling ~500 connections per seat per match is pure waste.
 */
export function loadModel(difficulty: Difficulty): LoadedModel {
  const hit = cache.get(difficulty);
  if (hit) return hit;

  const path = modelPath(difficulty);
  if (path === null) {
    throw new Error(
      `no trained model for "${difficulty}" — looked in ${modelSearchPaths().join(", ")}. ` +
        `Copy easy.json / medium.json / hard.json into one of those directories.`,
    );
  }

  const model = JSON.parse(readFileSync(path, "utf8")) as AiModel;
  // Throws and NAMES the differing field. Never coerced, never defaulted.
  assertModelCompatible(model);

  const loaded: LoadedModel = { difficulty, model, network: buildNetwork(model.genome), path };
  cache.set(difficulty, loaded);
  return loaded;
}

/** True when every difficulty is present and compatible. For a startup check. */
export function modelsAvailable(): { ok: boolean; detail: string } {
  const missing: string[] = [];
  const bad: string[] = [];
  for (const difficulty of ["easy", "medium", "hard"] as const) {
    try {
      loadModel(difficulty);
    } catch (error) {
      if (modelPath(difficulty) === null) missing.push(difficulty);
      else bad.push(`${difficulty}: ${(error as Error).message}`);
    }
  }
  if (missing.length === 0 && bad.length === 0) return { ok: true, detail: "all three models loaded" };
  return {
    ok: false,
    detail: [
      missing.length ? `missing: ${missing.join(", ")}` : "",
      bad.length ? `incompatible: ${bad.join("; ")}` : "",
    ].filter(Boolean).join(" | "),
  };
}

/** Provenance for logs and support: what exactly is this bot playing with. */
export function describeModel(difficulty: Difficulty): string {
  const { model, path } = loadModel(difficulty);
  return (
    `${difficulty} <- ${path} ` +
    `[format ${model.formatVersion}, obs ${model.identity.observationVersion}, ` +
    `act ${model.identity.actionVersion}, genome ${model.identity.genomeVersion}, ` +
    `engine ${model.identity.engineSha.slice(0, 10)}` +
    `${model.identity.engineDirty ? "+dirty" : ""}, ` +
    `balance ${model.identity.balanceConfigHash}, trained gen ${model.training.generation}]`
  );
}

/** Test seam only. */
export function clearModelCache(): void {
  cache.clear();
}
