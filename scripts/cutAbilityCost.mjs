import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { register } from "tsx/esm/api";

/**
 * Lowers the CAST cost of named abilities.
 *
 *   node scripts/cutAbilityCost.mjs <dataDir> <pct> <abilityId...>
 *   node scripts/cutAbilityCost.mjs src/data 40 waterBall waterfall flood
 *
 * For the outliers a global income change cannot reach. Raising
 * `INCOME_PER_CITIZEN` from 0.06 to 0.3 moved fifteen of sixteen kingdoms from
 * starved to comfortable — Fire went from 0.08x its cheapest ability to 2.29x —
 * but Water stayed at 0.33x at EVERY income tried, including 0.5. A kingdom that
 * does not respond to income needs its own prices moved.
 *
 * ⚠️ ANCHORED ON THE ABILITY, NOT ON ITS id. Status definitions reuse ability
 * ids and are declared above them, so `id: "dustBunnies"` matches the status
 * first; an earlier tool anchored that way and wrote five edits into the wrong
 * abilities. A candidate anchor is accepted only when no other `id: "` sits
 * between it and the `cost:` it claims.
 *
 * `unlockCost` is left ALONE. The measurement says these abilities are bought
 * and then unaffordable to fire, so the cast price is the lever; cutting both
 * would preserve the ratio that caused the problem.
 */

const [, , dataDir, pctArg, ...abilityIds] = process.argv;
if (!dataDir || !pctArg || abilityIds.length === 0) {
  console.error("usage: cutAbilityCost <dataDir> <pct> <abilityId...>");
  process.exit(1);
}
const pct = Number(pctArg);
if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
  console.error("pct must be a percentage between 0 and 100");
  process.exit(1);
}

register();
const { KINGDOM_IDS } = await import("../src/data/kingdoms.ts");
const { abilitiesForKingdom } = await import("../src/data/kingdomAbilities.ts");

/** Every ability's cast cost, before the edit. */
function snapshot() {
  const out = {};
  for (const k of KINGDOM_IDS) {
    for (const a of abilitiesForKingdom(k)) out[a.id] = a.cost;
  }
  return out;
}
const before = snapshot();

for (const id of abilityIds) {
  if (before[id] === undefined) {
    console.error(`no such ability: ${id}`);
    process.exit(1);
  }
}

const files = readdirSync(dataDir).filter((f) => f.endsWith("Abilities.ts"));
const edits = [];
const failures = [];

for (const file of files) {
  const path = join(dataDir, file);
  let text = readFileSync(path, "utf8");
  let changed = false;

  for (const abilityId of abilityIds) {
    const needle = `id: "${abilityId}"`;
    let from = 0;
    let done = false;
    while (!done) {
      const idAt = text.indexOf(needle, from);
      if (idAt < 0) break;
      const costAt = text.indexOf("cost:", idAt);
      if (costAt < 0) break;
      // Same object only, and not `unlockCost:` / `investCost:` caught mid-word.
      if (text.slice(idAt + needle.length, costAt).includes('id: "')) {
        from = idAt + needle.length;
        continue;
      }
      if (/[A-Za-z]/.test(text[costAt - 1] ?? "")) {
        from = costAt + 1;
        continue;
      }
      const match = /cost:\s*(\d+)/.exec(text.slice(costAt));
      if (!match) break;
      const current = Number(match[1]);
      const next = Math.max(1, Math.round(current * (1 - pct / 100)));
      text =
        text.slice(0, costAt) +
        text.slice(costAt).replace(/cost:\s*\d+/, `cost: ${next}`);
      edits.push(`${abilityId}: ${current} -> ${next}`);
      changed = true;
      done = true;
    }
    if (!done && text.includes(needle)) {
      failures.push(`${abilityId}: found in ${file} but no safe cost to edit`);
    }
  }
  if (changed) writeFileSync(path, text);
}

if (failures.length > 0) {
  console.error(`ABORTED — ${failures.length} edit(s) could not be located:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(`cut ${pct}% from ${edits.length} ability/ies:`);
for (const e of edits) console.log(`  ${e}`);
console.log(`\nRe-run the liquidity measurement to see whether it was enough.`);
