import { readFileSync } from "node:fs";
import { register } from "tsx/esm/api";

/**
 * Proves the upgrade repair landed, and that it landed ONLY where planned.
 *
 *   node scripts/verifyUpgradeRepair.mjs <plan.json> <before.json> <registryPath>
 *
 * ⚠️ THIS IS THE CHECK THAT WAS MISSING. The upgrade tables were corrupted by an
 * applier whose edits nobody re-read: 43 tiers ended up worse than the value
 * they replace, and every test in the repo went on passing because the tests
 * asserted the numbers rather than the relationship.
 *
 * Two assertions, and the second matters more than the first:
 *
 *   1. Every planned value is now in the data.
 *   2. NOTHING ELSE in any ladder moved. An edit that lands where it was not
 *      planned is exactly the failure mode being repaired here.
 */

register();
const [, , planPath, beforePath, registryPath] = process.argv;
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const before = JSON.parse(readFileSync(beforePath, "utf8"));
const { ALL_ABILITIES } = await import(registryPath);

const after = {};
for (const a of Object.values(ALL_ABILITIES)) {
  after[a.id] = {
    baseAmount: a.effects?.[0]?.params?.amount ?? null,
    baseCooldown: a.cooldownTicks ?? null,
    tiers: (a.upgradePath ?? []).map((t) => ({
      level: t.level,
      amount: t.changes?.effectParams?.[0]?.amount ?? null,
      cooldown: t.changes?.cooldownTicks ?? null,
    })),
  };
}

const wanted = new Map();
for (const row of plan) wanted.set(`${row.ability}:${row.level}:${row.field}`, row.becomes);

const missed = [];
const strayed = [];

for (const [id, ladder] of Object.entries(after)) {
  const prior = before[id];
  if (!prior) { strayed.push(`${id}: ability appeared from nowhere`); continue; }

  if (ladder.baseAmount !== prior.baseAmount) {
    strayed.push(`${id} BASE amount ${prior.baseAmount} -> ${ladder.baseAmount}`);
  }
  if (ladder.baseCooldown !== prior.baseCooldown) {
    strayed.push(`${id} BASE cooldown ${prior.baseCooldown} -> ${ladder.baseCooldown}`);
  }

  for (const tier of ladder.tiers) {
    const was = prior.tiers.find((t) => t.level === tier.level);
    for (const field of ["amount", "cooldown"]) {
      const key = `${id}:${tier.level}:${field}`;
      const now = tier[field];
      const then = was ? was[field] : null;
      if (wanted.has(key)) {
        if (now !== wanted.get(key)) {
          missed.push(`${key}: expected ${wanted.get(key)}, found ${now}`);
        }
        wanted.delete(key);
      } else if (now !== then) {
        strayed.push(`${key}: ${then} -> ${now} — NOT IN THE PLAN`);
      }
    }
  }
}

console.log(`VERIFY UPGRADE REPAIR\n`);
console.log(`  planned edits        ${plan.length}`);
console.log(`  landed correctly     ${plan.length - missed.length - wanted.size}`);
console.log(`  missing / wrong      ${missed.length + wanted.size}`);
console.log(`  unplanned changes    ${strayed.length}`);

for (const m of missed) console.log(`  ✖ ${m}`);
for (const k of wanted.keys()) console.log(`  ✖ ${k}: planned but never applied`);
for (const s of strayed.slice(0, 20)) console.log(`  ⚠ ${s}`);

const clean = missed.length === 0 && wanted.size === 0 && strayed.length === 0;
console.log(`\n  ${clean ? "PASS — every planned edit landed, nothing else moved" : "FAIL"}`);
process.exit(clean ? 0 : 1);
