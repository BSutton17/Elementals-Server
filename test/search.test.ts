import { test } from "node:test";
import assert from "node:assert/strict";
import { listParameters } from "../src/engine/parameterCatalog.js";
import {
  Cmaes,
  CandidateCache,
  buildSchema,
  candidateHash,
  coerce,
  decode,
  encode,
  jacobiEigen,
  makeCandidate,
  searchable,
  baseVector,
  vectorToParameters,
  type CandidateEvaluation,
} from "../simulation/src/search/index.js";
import { FITNESS_VERSION } from "../simulation/src/fitness/index.js";

/**
 * Balance search (Step 8).
 *
 * This is the first component permitted to change game parameters, so most of
 * these tests are about the limits of that permission: what it may touch, how
 * far, and whether a run can be reproduced exactly from its seed.
 */

// --- schema ------------------------------------------------------------------

test("the schema is a small curated subset of a much larger catalog", () => {
  const schema = buildSchema();
  const catalog = listParameters().length;
  const active = searchable(schema);
  assert.ok(catalog > 500, `expected a large catalog, saw ${catalog}`);
  // Handing CMA-ES hundreds of dimensions would be slow to converge and
  // produce an unreviewable diff.
  assert.ok(active.length >= 10 && active.length <= 30, `curated set is ${active.length}`);
  assert.ok(active.length < catalog / 10);
});

test("every schema parameter exists in the live catalog", () => {
  // A schema referencing a tunable the engine no longer exposes would silently
  // optimise nothing, so building it must fail loudly instead.
  const ids = new Set(listParameters().map((p) => p.id));
  for (const p of buildSchema().parameters) {
    assert.ok(ids.has(p.id), `${p.id} is not exposed by the engine`);
  }
});

test("bases are read from the engine, never hardcoded", () => {
  const catalog = new Map(listParameters().map((p) => [p.id, p.base]));
  for (const p of buildSchema().parameters) {
    assert.equal(p.base, catalog.get(p.id), `${p.id} base drifted from the engine`);
  }
});

test("locked parameters cannot be searched", () => {
  const schema = buildSchema();
  const locked = schema.parameters.filter((p) => p.locked);
  assert.ok(locked.length > 0, "expected at least one locked parameter");
  // Income per citizen is a standing design decision, not a tunable.
  const income = schema.parameters.find((p) => p.id === "economy.incomePerCitizen");
  assert.ok(income?.locked, "economy.incomePerCitizen must be locked");
  assert.equal(income.min, income.base);
  assert.equal(income.max, income.base);
  const active = searchable(schema).map((p) => p.id);
  for (const p of locked) assert.ok(!active.includes(p.id), `${p.id} leaked into the search`);
});

test("bounds are ordered even for negative bases", () => {
  const schema = buildSchema();
  for (const p of schema.parameters) {
    assert.ok(p.min <= p.max, `${p.id}: inverted bounds`);
    assert.ok(p.base >= p.min && p.base <= p.max, `${p.id}: base outside its own bounds`);
  }
  // Ice's status-duration passive is negative; a naive base*0.6 / base*1.4
  // would invert it.
  const ice = schema.parameters.find((p) => p.id === "passive.ice.0.pct");
  assert.ok(ice && ice.base < 0, "expected a negative base to exercise this");
  assert.ok(ice.min < ice.base && ice.base < ice.max);
});

test("probability parameters stay within [0,1]", () => {
  for (const p of buildSchema().parameters) {
    if (!/chance$/i.test(p.id)) continue;
    assert.ok(p.min >= 0, `${p.id} could go negative`);
    assert.ok(p.max <= 1, `${p.id} could exceed certainty`);
  }
});

test("values are clamped and quantised on decode", () => {
  const schema = buildSchema();
  for (const p of searchable(schema)) {
    // The optimizer works unbounded; enforcement happens here, not in CMA-ES.
    const low = p.type === "integer" ? Math.ceil(p.min) : p.min;
    const high = p.type === "integer" ? Math.floor(p.max) : p.max;
    assert.equal(coerce(p, -1e9), low, `${p.id} floor`);
    assert.equal(coerce(p, 1e9), high, `${p.id} ceiling`);
    // Decoding a wildly out-of-range coordinate must still land in bounds.
    assert.ok(decode(p, -5) >= low - 1e-9, `${p.id} underflowed`);
    assert.ok(decode(p, 5) <= high + 1e-9, `${p.id} overflowed`);
    if (p.type === "integer") assert.ok(Number.isInteger(decode(p, 0.37)));
  }
});

test("encode and decode round-trip the base configuration", () => {
  const schema = buildSchema();
  const params = vectorToParameters(schema, baseVector(schema));
  for (const p of searchable(schema)) {
    assert.ok(
      Math.abs(params[p.id]! - p.base) < 1e-6,
      `${p.id}: ${params[p.id]} !== ${p.base}`,
    );
  }
});

test("no vector, however wild, produces an out-of-bounds game", () => {
  const schema = buildSchema();
  const params = searchable(schema);
  for (const unit of [-10, -0.3, 0, 0.5, 1, 1.7, 42]) {
    const values = vectorToParameters(schema, new Array(params.length).fill(unit));
    for (const p of params) {
      const v = values[p.id]!;
      assert.ok(v >= p.min - 1e-9 && v <= p.max + 1e-9, `${p.id} escaped to ${v}`);
    }
  }
});

// --- candidates ---------------------------------------------------------------

test("candidate hashes are deterministic and value-sensitive", () => {
  const schema = buildSchema();
  const a = { "castle.repairCost": 500, "shield.cost": 400 };
  const b = { "shield.cost": 400, "castle.repairCost": 500 };
  assert.equal(candidateHash(schema, a), candidateHash(schema, b), "key order must not matter");
  assert.notEqual(
    candidateHash(schema, a),
    candidateHash(schema, { ...a, "shield.cost": 401 }),
  );
});

test("a candidate carries everything needed to reproduce it", () => {
  const schema = buildSchema();
  const vector = baseVector(schema);
  const c = makeCandidate({
    schema, vector, parameters: vectorToParameters(schema, vector),
    generation: 3, index: 7, optimizer: "cmaes",
  });
  assert.equal(c.id, "gen003-c07");
  assert.equal(c.generation, 3);
  assert.equal(c.schemaVersion, schema.version);
  assert.equal(c.vector.length, vector.length);
  assert.ok(Object.keys(c.parameters).length === searchable(schema).length);
});

test("the cache refuses to reuse a score across a changed context", () => {
  const schema = buildSchema();
  const vector = baseVector(schema);
  const candidate = makeCandidate({
    schema, vector, parameters: vectorToParameters(schema, vector),
    generation: 0, index: 0, optimizer: "cmaes",
  });
  const entry: CandidateEvaluation = {
    candidate, tier: "screen", fitness: null, failure: null, durationMs: 1, cached: false,
  };
  const context = {
    engineSha: "abc", fitnessVersion: FITNESS_VERSION, schemaVersion: schema.version,
    seedPool: "training", samplerVersions: "coverage/stratified",
  };
  const cache = new CandidateCache(context);
  cache.set(entry);
  assert.ok(cache.get(candidate.hash, "screen"), "same context should hit");
  // A different TIER is a different measurement, not the same one.
  assert.equal(cache.get(candidate.hash, "full"), undefined);
  // A score from another engine must never be reused.
  const other = new CandidateCache({ ...context, engineSha: "def" });
  other.set(entry);
  assert.ok(other.get(candidate.hash, "screen"));
  const stats = cache.stats;
  assert.ok(stats.hits >= 1 && stats.misses >= 1);
});

// --- CMA-ES --------------------------------------------------------------------

test("CMA-ES optimises a known function", () => {
  // Proving the strategy works on ground truth is cheaper and far more
  // conclusive than inferring it from noisy game evaluations.
  const target = 0.7;
  const dimension = 20;
  const cma = new Cmaes({
    dimension, mean: new Array(dimension).fill(0.2), sigma: 0.3, seed: 7,
  });
  let best = -Infinity;
  for (let g = 0; g < 100; g++) {
    const population = cma.ask();
    const fitness = population.map((x) => -x.reduce((s, v) => s + (v - target) ** 2, 0));
    cma.tell(population, fitness);
    best = Math.max(best, ...fitness);
  }
  assert.ok(best > -1e-3, `expected convergence, best was ${best}`);
  for (const m of cma.state.mean) assert.ok(Math.abs(m - target) < 0.05);
});

test("CMA-ES is reproducible from its seed", () => {
  const run = () => {
    const cma = new Cmaes({ dimension: 8, mean: new Array(8).fill(0.5), sigma: 0.25, seed: 99 });
    const trace: number[] = [];
    for (let g = 0; g < 6; g++) {
      const population = cma.ask();
      cma.tell(population, population.map((x) => -x.reduce((s, v) => s + v * v, 0)));
      trace.push(...population.flat(), cma.state.sigma);
    }
    return JSON.stringify(trace);
  };
  assert.equal(run(), run(), "same seed must produce the same candidate sequence");
});

test("different seeds explore differently", () => {
  const first = (seed: number) =>
    JSON.stringify(new Cmaes({ dimension: 6, mean: new Array(6).fill(0.5), sigma: 0.2, seed }).ask());
  assert.notEqual(first(1), first(2));
});

test("CMA-ES tolerates a fitness plateau without diverging", () => {
  // Every candidate scoring identically is a real possibility here: the
  // constraint cap flattens whole regions of the space.
  const cma = new Cmaes({ dimension: 5, mean: new Array(5).fill(0.5), sigma: 0.2, seed: 3 });
  for (let g = 0; g < 30; g++) {
    const population = cma.ask();
    cma.tell(population, population.map(() => 0.6));
  }
  assert.ok(Number.isFinite(cma.state.sigma));
  assert.ok(cma.state.sigma > 0);
  for (const m of cma.state.mean) assert.ok(Number.isFinite(m));
});

test("the eigen solver decomposes a symmetric matrix correctly", () => {
  const m = [
    [4, 1, 0],
    [1, 3, 1],
    [0, 1, 2],
  ];
  const { vectors, values } = jacobiEigen(m);
  // Reconstruct: B * diag(values) * B^T should return the original.
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += vectors[i]![k]! * values[k]! * vectors[j]![k]!;
      assert.ok(Math.abs(s - m[i]![j]!) < 1e-8, `reconstruction failed at ${i},${j}`);
    }
  }
});

// --- the boundary that matters --------------------------------------------------

test("fitness rules are not reachable from the search space", () => {
  // The optimizer may change the game; it must never be able to change what
  // counts as balanced, or it could "improve" the score by moving the goalposts.
  const forbidden = [
    "duelWinRateBound", "ffaFirstFloorRatio", "ffaLastCeilingRatio",
    "violationCap", "weight", "ffa4", "ffa7", "duel",
  ];
  for (const p of searchable(buildSchema())) {
    for (const f of forbidden) {
      assert.ok(
        !p.id.toLowerCase().includes(f.toLowerCase()),
        `${p.id} looks like a fitness rule, not a game parameter`,
      );
    }
    // Everything searchable must be a real engine tunable.
    assert.ok(
      p.id.startsWith("passive.") || p.id.startsWith("castle.") ||
        p.id.startsWith("shield.") || p.id.startsWith("combat.") ||
        p.id.startsWith("ability.") || p.id.startsWith("economy.") ||
        p.id.startsWith("status.") || p.id.startsWith("citizens.") ||
        p.id.startsWith("targeting."),
      `${p.id} is not a recognised engine parameter namespace`,
    );
  }
});
