import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes an approved balance candidate into the ability data files.
 *
 *   node scripts/applyBalance.mjs <candidate.json> [--dry]
 *
 * The data files are the source of truth: `parameterCatalog.ts` walks the live
 * ability definitions to produce each parameter's BASE, so a runtime override
 * would let the game play the new numbers while the next balance search still
 * started from the old ones. Baking them in is what moves the baseline.
 *
 * Edits are structural rather than free regex: for each ability the script
 * takes the region from its `id:` to the next one, and inside that region
 * rewrites the FIRST `cost:` (upgrade-tier costs come later, under
 * `upgradePath`), the FIRST `cooldownTicks:`, and the first `amount:` /
 * `durationTicks:` after `effects: [`.
 *
 * ⚠️ That last rule is a heuristic — an ability whose first effect carries no
 * amount would have its SECOND effect rewritten instead. Which is why nothing
 * here is trusted: `verifyBalance.mjs` re-reads the catalog in a fresh process
 * and fails on any parameter that did not land exactly. Run it every time.
 *
 * Tick-valued fields keep their `TICK.RATE` relationship rather than becoming
 * bare literals, so cooldowns still scale if the tick rate is ever changed.
 */

const [, , candidatePath, ...flags] = process.argv;
const dry = flags.includes("--dry");
if (!candidatePath) {
  console.error("usage: node scripts/applyBalance.mjs <candidate.json> [--dry]");
  process.exit(1);
}

const TICK_RATE = 20;
const raw = JSON.parse(readFileSync(candidatePath, "utf8"));
const params = Array.isArray(raw)
  ? raw[0].parameters
  : raw.parameters ?? raw;

// Poison Apple's duration is a sentinel — its base is Number.MAX_SAFE_INTEGER,
// meaning "permanent". Any value the search picks is functionally identical, so
// applying one would be noise dressed as a decision. Left alone deliberately.
const SENTINEL = "ability.poisonApple.effects.0.durationTicks";
const skipped = [];

const DIR = "src/data";
const files = readdirSync(DIR).filter((f) => f.endsWith("Abilities.ts"));
const source = new Map(files.map((f) => [f, readFileSync(join(DIR, f), "utf8")]));

/** Where does this ability live, and what span of the file is its definition? */
function regionFor(abilityId) {
  for (const [file, text] of source) {
    const marker = `id: "${abilityId}",`;
    let at = text.indexOf(marker);
    while (at >= 0) {
      const next = text.indexOf(`
  id: "`, at + marker.length);
      const end = next < 0 ? text.length : next;
      const block = text.slice(at, end);
      // An ability definition always carries a cost and an effects list; a
      // status effect or a modifier block carries neither. An id is NOT unique
      // in a file — `thunderdome` names both a status and the ability that
      // applies it, and the status is declared first.
      if (/\bcost:/.test(block) && /\beffects:\s*\[/.test(block)) {
        return { file, start: at, end };
      }
      at = text.indexOf(marker, at + marker.length);
    }
  }
  return null;
}

/** Replaces `field: <anything up to the line's comma>` inside [start,end). */
function replaceField(text, start, end, field, literal, after = null) {
  let from = start;
  if (after !== null) {
    const at = text.indexOf(after, start);
    if (at < 0 || at >= end) return null;
    from = at;
  }
  // Field must be followed by a value that ends at a comma or a closing brace.
  const re = new RegExp(`(\\b${field}:\\s*)([^,}\\n]+)`, "g");
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m || m.index >= end) return null;
  return {
    text: text.slice(0, m.index) + m[1] + literal + text.slice(m.index + m[0].length),
    was: m[2].trim(),
  };
}

const TICK_FIELDS = new Set(["cooldownTicks", "durationTicks", "rechargeTicks"]);

function literalFor(field, value) {
  const n = Math.round(value);
  if (!TICK_FIELDS.has(field)) return { literal: String(n), note: String(n) };
  // Keep the tick-rate relationship: seconds x TICK.RATE, rounded back to the
  // exact tick count the search chose.
  const seconds = n / TICK_RATE;
  return {
    literal: `Math.round(${seconds} * TICK.RATE)`,
    note: `${n} ticks (${seconds}s)`,
  };
}

const applied = [];
const failed = [];

for (const [id, value] of Object.entries(params)) {
  if (id === SENTINEL) { skipped.push(id); continue; }

  const m = /^ability\.([A-Za-z0-9]+)\.(.+)$/.exec(id);
  if (!m) { failed.push(`${id}: not an ability parameter`); continue; }
  const [, abilityId, rest] = m;

  const region = regionFor(abilityId);
  if (!region) { failed.push(`${id}: no definition found for "${abilityId}"`); continue; }

  let field = null;
  let after = null;
  if (rest === "cost" || rest === "cooldownTicks" || rest === "unlockCost") {
    field = rest;
  } else {
    const e = /^effects\.(\d+)\.(.+)$/.exec(rest);
    if (e) {
      field = e[2];
      after = "effects: [";
    }
  }
  if (!field) { failed.push(`${id}: unhandled parameter shape`); continue; }

  const { literal, note } = literalFor(field, value);
  const text = source.get(region.file);
  const out = replaceField(text, region.start, region.end, field, literal, after);
  if (!out) { failed.push(`${id}: could not locate "${field}" in ${region.file}`); continue; }

  source.set(region.file, out.text);
  applied.push({ id, file: region.file, was: out.was, now: note });
}

console.log(`applied ${applied.length}   failed ${failed.length}   skipped ${skipped.length}`);
for (const s of skipped) console.log(`  skipped (sentinel): ${s}`);
for (const f of failed) console.log(`  FAILED: ${f}`);

if (!dry) {
  for (const [file, text] of source) writeFileSync(join(DIR, file), text, "utf8");
  console.log(`\nwrote ${source.size} files. Now run: node scripts/verifyBalance.mjs ${candidatePath}`);
} else {
  console.log("\n--dry: nothing written");
}
if (failed.length > 0) process.exit(1);
