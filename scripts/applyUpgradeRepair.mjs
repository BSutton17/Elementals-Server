import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Applies the upgrade-tier repair plan to the ability data files.
 *
 *   node scripts/applyUpgradeRepair.mjs <plan.json> <dataDir>
 *
 * ⚠️ THIS EDITS THE SAME FILES THE LAST APPLIER CORRUPTED, so it is deliberately
 * not built the same way. `applyBalance.mjs` searched for "the first `amount:`
 * after `effects: [`", which silently walked into an upgrade tier whenever an
 * ability's effects were built by a helper. The damage was invisible: nothing
 * re-read the file to confirm what landed.
 *
 * Here every edit is bounded by structure — the ability's own `upgradePath`
 * array, then the tier carrying the target `level`, then the field inside that
 * tier's `changes` — and each edit must match EXACTLY ONCE inside its bounds or
 * the run aborts having written nothing.
 *
 * `verifyUpgradeRepair.mjs` then re-reads the compiled data and asserts every
 * planned value landed and no other ladder value moved.
 */

const [, , planPath, dataDir] = process.argv;
if (!planPath || !dataDir) {
  console.error("usage: applyUpgradeRepair <plan.json> <dataDir>");
  process.exit(1);
}

const plan = JSON.parse(readFileSync(planPath, "utf8"));

/** Index just past the bracket that closes the one opening at `open`. */
function matchBracket(text, open, oc, cc) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === oc) depth += 1;
    else if (ch === cc) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced brackets");
}

/**
 * The [start,end) slice of `id`'s upgradePath array.
 *
 * ⚠️ THE ANCHOR MUST BE THE ABILITY, NOT ANY OBJECT CARRYING THAT id. Status
 * definitions reuse the ability's id and are declared ABOVE it —
 * `DUST_BUNNIES_STATUS = { id: "dustBunnies", … }`. Anchoring on the first
 * match then scanning forward for `upgradePath:` walks straight past the status
 * into the NEXT ability's ladder: a first run of this script wrote five edits
 * into aLightBreeze, lightBeam, foxSwipe and venomShot before the verifier
 * caught it.
 *
 * So a candidate anchor is only accepted when no other `id: "` appears between
 * it and the `upgradePath:` it claims — which is exactly the condition that the
 * two belong to the same object literal.
 */
function upgradePathBounds(text, abilityId) {
  const needle = `id: "${abilityId}"`;
  let from = 0;
  for (;;) {
    const idAt = text.indexOf(needle, from);
    if (idAt < 0) return null;
    const pathAt = text.indexOf("upgradePath:", idAt);
    if (pathAt < 0) return null;
    const between = text.slice(idAt + needle.length, pathAt);
    if (!between.includes('id: "')) {
      const open = text.indexOf("[", pathAt);
      const close = matchBracket(text, open, "[", "]");
      return { start: open, end: close };
    }
    from = idAt + needle.length;
  }
}

/** The [start,end) slice of the tier object carrying `level: n`. */
function tierBounds(text, bounds, level) {
  let cursor = bounds.start;
  while (cursor < bounds.end) {
    const at = text.indexOf(`level: ${level}`, cursor);
    if (at < 0 || at > bounds.end) return null;
    // Walk back to this tier object's opening brace.
    let open = text.lastIndexOf("{", at);
    const close = matchBracket(text, open, "{", "}");
    // Guard against `level: 1` matching `level: 10` and similar.
    const after = text[at + `level: ${level}`.length];
    if (after === "," || after === "\n" || after === " " || after === "}") {
      return { start: open, end: close };
    }
    cursor = at + 1;
  }
  return null;
}

const files = readdirSync(dataDir).filter((f) => f.endsWith("Abilities.ts"));
const edits = [];
const failures = [];

// Group by ability so each file is read and written once.
const byAbility = new Map();
for (const row of plan) {
  if (!byAbility.has(row.ability)) byAbility.set(row.ability, []);
  byAbility.get(row.ability).push(row);
}

const contents = new Map();
for (const file of files) {
  contents.set(file, readFileSync(join(dataDir, file), "utf8"));
}

for (const [abilityId, rows] of byAbility) {
  const file = files.find((f) => contents.get(f).includes(`id: "${abilityId}"`));
  if (!file) {
    failures.push(`${abilityId}: not found in any ability file`);
    continue;
  }
  let text = contents.get(file);

  // Highest level first: editing a later tier cannot shift the offsets of an
  // earlier one, so bounds stay valid across the whole ability.
  for (const row of [...rows].sort((a, b) => b.level - a.level)) {
    const bounds = upgradePathBounds(text, abilityId);
    if (!bounds) { failures.push(`${abilityId}: no upgradePath`); continue; }
    const tier = tierBounds(text, bounds, row.level);
    if (!tier) { failures.push(`${abilityId} Lv${row.level}: tier not found`); continue; }

    const slice = text.slice(tier.start, tier.end + 1);
    let updated;

    if (row.field === "amount") {
      const ep = slice.indexOf("effectParams:");
      if (ep < 0) { failures.push(`${abilityId} Lv${row.level}: no effectParams`); continue; }
      const rx = /amount:\s*[-\d.]+/;
      const target = slice.slice(ep);
      if (!rx.test(target)) { failures.push(`${abilityId} Lv${row.level}: no amount`); continue; }
      updated = slice.slice(0, ep) + target.replace(rx, `amount: ${row.becomes}`);
    } else {
      // cooldownTicks directly inside `changes`, never one nested in effectParams.
      const rx = /cooldownTicks:\s*[^,\n}]+/;
      if (!rx.test(slice)) { failures.push(`${abilityId} Lv${row.level}: no cooldownTicks`); continue; }
      updated = slice.replace(rx, `cooldownTicks: ${row.becomes}`);
    }

    text = text.slice(0, tier.start) + updated + text.slice(tier.end + 1);
    edits.push(`${abilityId} Lv${row.level} ${row.field} ${row.was} -> ${row.becomes}`);
  }
  contents.set(file, text);
}

if (failures.length > 0) {
  console.error(`ABORTED — ${failures.length} edit(s) could not be located safely:\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(`\nNothing was written.`);
  process.exit(1);
}

for (const [file, text] of contents) {
  writeFileSync(join(dataDir, file), text);
}

console.log(`applied ${edits.length} edit(s) across ${files.length} file(s)`);
for (const e of edits) console.log(`  ${e}`);
