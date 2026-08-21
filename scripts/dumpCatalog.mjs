import { writeFileSync } from "node:fs";
import { register } from "tsx/esm/api";

/**
 * Snapshots every catalog parameter's current value.
 *
 *   node scripts/dumpCatalog.mjs <out.json>
 *
 * Take this BEFORE applying a balance candidate, then pass it to
 * `verifyBalance.mjs --before <out.json>`. That turns "did the values I asked
 * for land?" into "…and did anything else move?", which is the question that
 * would have caught 43 corrupted upgrade tiers two applies ago.
 */
register();
const { listParameters } = await import("../src/engine/parameterCatalog.ts");
const [, , outPath] = process.argv;
const snapshot = Object.fromEntries(listParameters().map((p) => [p.id, p.base]));
writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
console.log(`wrote ${Object.keys(snapshot).length} parameters to ${outPath}`);
