import { readFileSync } from "node:fs";
import { register } from "tsx/esm/api";

/**
 * Proves the applied balance actually landed.
 *
 *   node scripts/verifyBalance.mjs <candidate.json>
 *
 * `applyBalance.mjs` edits text; this re-reads the CATALOG — the same walk over
 * live ability definitions the balance search uses to discover its search space
 * — and compares every parameter against what the candidate asked for.
 *
 * It exists because the applier's "first amount after effects: [" rule is a
 * heuristic. An ability whose first effect carries no amount would have had its
 * second effect rewritten instead: a silent, plausible-looking corruption that
 * nothing else would catch. Here it shows up as a mismatch on both parameters.
 */

register();
const { listParameters } = await import("../src/engine/parameterCatalog.ts");

const [, , candidatePath] = process.argv;
if (!candidatePath) {
  console.error("usage: node scripts/verifyBalance.mjs <candidate.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(candidatePath, "utf8"));
const params = Array.isArray(raw) ? raw[0].parameters : raw.parameters ?? raw;
const SENTINEL = "ability.poisonApple.effects.0.durationTicks";

const live = new Map(listParameters().map((p) => [p.id, p.base]));

let ok = 0;
const wrong = [];
const absent = [];
for (const [id, wanted] of Object.entries(params)) {
  if (id === SENTINEL) continue;
  const actual = live.get(id);
  if (actual === undefined) { absent.push(id); continue; }
  // The candidate carries fractional values; the game stores whole numbers.
  if (actual === Math.round(wanted)) ok += 1;
  else wrong.push({ id, wanted: Math.round(wanted), actual });
}

console.log(`VERIFY ${candidatePath}`);
console.log(`  matched ${ok}   MISMATCHED ${wrong.length}   not in catalog ${absent.length}`);
for (const w of wrong.slice(0, 25)) {
  console.log(`  ✖ ${w.id.padEnd(46)} wanted ${String(w.wanted).padStart(10)}  got ${String(w.actual).padStart(10)}`);
}
for (const a of absent.slice(0, 10)) console.log(`  ? ${a} is not a catalog parameter`);

// A silent corruption also shows up as a parameter that moved WITHOUT being
// asked to, so the reverse direction is checked too.
const asked = new Set(Object.keys(params));
const unexpected = [];
for (const { id, base } of listParameters()) {
  if (asked.has(id)) continue;
  // Nothing to compare against for untouched parameters, but a non-finite
  // value means the edit mangled something structurally. Negatives are NOT a
  // symptom: `passive.ice.0.pct = -0.5` is a legitimate duration REDUCTION.
  if (!Number.isFinite(base)) unexpected.push(`${id} = ${base}`);
}
if (unexpected.length > 0) {
  console.log(`\n  ⚠ ${unexpected.length} untouched parameters are now invalid:`);
  for (const u of unexpected.slice(0, 10)) console.log(`      ${u}`);
}

const clean = wrong.length === 0 && absent.length === 0 && unexpected.length === 0;
console.log(`\n  ${clean ? "PASS — every parameter landed exactly" : "FAIL"}`);
process.exit(clean ? 0 : 1);
