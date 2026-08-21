import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes each ability's unlock price down, so the search can tune it.
 *
 *   node scripts/makeUnlockCostExplicit.mjs <before.json> <dataDir>
 *
 * ⚠️ WHY THIS IS THE FIX. 13 of the 16 never-cast abilities are never BOUGHT,
 * not "cast too rarely" — the AI never holds enough gold to unlock them. Its
 * median peak liquidity in a match is 253 gold, and Earthquake's unlock is 350,
 * Riptide's 673. Those two were affordable on ZERO of ~5,000 decisions.
 *
 * The balance search could not reach that, because for 78 of 80 abilities the
 * unlock price is DERIVED as `ceil(cost * 0.5)` and welded to the cast price.
 * Halving Earthquake's cost to bring the unlock within reach also halves what
 * it costs to spam, which wrecks balance — so the search correctly refused, and
 * forty generations of price search left coverage worse than it started.
 *
 * Making the number explicit splits acquisition from spam. Day one it changes
 * NOTHING: each ability is given exactly the figure the game was already
 * computing for it. `verifyUnlockCost.mjs` proves that before anything else is
 * allowed to move.
 *
 * The edit is anchored the way `applyUpgradeRepair.mjs` learned to be: on the
 * object that actually declares the ability, never on a status that reuses its
 * id.
 */

const [, , beforePath, dataDir] = process.argv;
if (!beforePath || !dataDir) {
  console.error("usage: makeUnlockCostExplicit <before.json> <dataDir>");
  process.exit(1);
}

const before = JSON.parse(readFileSync(beforePath, "utf8"));
const files = readdirSync(dataDir).filter((f) => f.endsWith("Abilities.ts"));

const added = [];
const skipped = [];
const failures = [];

for (const file of files) {
  const path = join(dataDir, file);
  let text = readFileSync(path, "utf8");
  let changed = false;

  for (const [abilityId, info] of Object.entries(before)) {
    if (info.explicit !== null) { skipped.push(`${abilityId} (already explicit)`); continue; }

    const needle = `id: "${abilityId}"`;
    let from = 0;
    let done = false;

    while (!done) {
      const idAt = text.indexOf(needle, from);
      if (idAt < 0) break;

      // The ability's own object is the one whose next `cost:` arrives before
      // any other `id: "` — a status carrying the same id has no cost of its
      // own, so anchoring on it would push the field into the wrong literal.
      const costAt = text.indexOf("cost:", idAt);
      if (costAt < 0) break;
      const between = text.slice(idAt + needle.length, costAt);
      if (between.includes('id: "')) { from = idAt + needle.length; continue; }

      // `cost:` must not be `unlockCost:` or `investCost:` caught mid-word.
      const before2 = text[costAt - 1];
      if (before2 && /[A-Za-z]/.test(before2)) { from = costAt + 1; continue; }

      const lineEnd = text.indexOf("\n", costAt);
      if (lineEnd < 0) break;
      const indent = text.slice(text.lastIndexOf("\n", costAt) + 1, costAt);

      text =
        text.slice(0, lineEnd + 1) +
        `${indent}unlockCost: ${info.effective},\n` +
        text.slice(lineEnd + 1);
      added.push(`${abilityId} unlockCost: ${info.effective} (was ceil(${info.cost}/2))`);
      changed = true;
      done = true;
    }
    if (!done && info.explicit === null && text.includes(needle)) {
      failures.push(`${abilityId}: found in ${file} but no safe insertion point`);
    }
  }

  if (changed) writeFileSync(path, text);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} ability/ies could not be edited safely:`);
  for (const f of failures) console.error(`  ${f}`);
}
console.log(`added unlockCost to ${added.length} abilities, skipped ${skipped.length} already explicit`);
if (failures.length > 0) process.exit(1);
