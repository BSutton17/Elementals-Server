import { readFileSync, writeFileSync } from "node:fs";

/**
 * Plans the repair of upgrade tiers that stopped being upgrades.
 *
 *   node scripts/planUpgradeRepair.mjs <pre.json> <now.json> <plan.json>
 *
 * ⚠️ THE SEARCH NEVER CHOSE THESE VALUES. Upgrade tiers are 221 parameters in
 * the catalog and 0 dimensions in either search scope. `applyBalance.mjs` wrote
 * them as a side effect of its text-editing heuristic, with nothing enforcing
 * that a tier must beat what it replaces — and `verifyBalance.mjs` never
 * noticed, because it only checks that SUPPLIED parameters landed.
 *
 * So the repair target is the DESIGNED ratio, recovered from the data as it
 * stood before that apply, and reapplied to whatever base the search has since
 * chosen. That keeps the ladder the designer shaped while respecting the
 * balance the search found.
 *
 * Only NON-IMPROVING tiers are touched. A tier that still improves is left
 * exactly as it is, however the number arrived, because changing it would be a
 * balance decision rather than a repair.
 *
 * Where the pre-balance data offers no usable ratio, the house median across
 * every healthy tier in the game is used instead, and the row is marked so the
 * fallback is visible rather than silent.
 */

const [, , prePath, nowPath, planPath] = process.argv;
const pre = JSON.parse(readFileSync(prePath, "utf8"));
const now = JSON.parse(readFileSync(nowPath, "utf8"));

// House style, measured from every tier that still improves. See
// scripts/analyzeUpgradeSteps.mjs.
const FALLBACK_DAMAGE = 1.2;
const FALLBACK_COOLDOWN = 0.9;

/** The ratios the designer used, per ability and tier, before the apply. */
function designedRatios(ladder) {
  if (!ladder) return new Map();
  const out = new Map();
  let amount = ladder.baseAmount;
  let cooldown = ladder.baseCooldown;
  for (const tier of ladder.tiers) {
    if (typeof tier.amount === "number" && typeof amount === "number" && amount > 0) {
      out.set(`${tier.level}:amount`, tier.amount / amount);
      amount = tier.amount;
    }
    if (typeof tier.cooldown === "number" && typeof cooldown === "number" && cooldown > 0) {
      out.set(`${tier.level}:cooldown`, tier.cooldown / cooldown);
      cooldown = tier.cooldown;
    }
  }
  return out;
}

const plan = [];

for (const [id, ladder] of Object.entries(now)) {
  const ratios = designedRatios(pre[id]);
  let amount = ladder.baseAmount;
  let cooldown = ladder.baseCooldown;

  for (const tier of ladder.tiers) {
    if (typeof tier.amount === "number" && typeof amount === "number") {
      if (tier.amount <= amount) {
        let ratio = ratios.get(`${tier.level}:amount`);
        let source = "designed";
        if (!(typeof ratio === "number" && ratio > 1)) {
          ratio = FALLBACK_DAMAGE;
          source = "house-median";
        }
        const repaired = Math.max(amount + 1, Math.round(amount * ratio));
        plan.push({
          ability: id, level: tier.level, field: "amount",
          replaces: amount, was: tier.amount, becomes: repaired,
          ratio: Number(ratio.toFixed(4)), source,
        });
        amount = repaired;
      } else {
        amount = tier.amount;
      }
    }
    if (typeof tier.cooldown === "number" && typeof cooldown === "number") {
      if (tier.cooldown >= cooldown) {
        let ratio = ratios.get(`${tier.level}:cooldown`);
        let source = "designed";
        if (!(typeof ratio === "number" && ratio > 0 && ratio < 1)) {
          ratio = FALLBACK_COOLDOWN;
          source = "house-median";
        }
        const repaired = Math.min(cooldown - 1, Math.round(cooldown * ratio));
        plan.push({
          ability: id, level: tier.level, field: "cooldown",
          replaces: cooldown, was: tier.cooldown, becomes: repaired,
          ratio: Number(ratio.toFixed(4)), source,
        });
        cooldown = repaired;
      } else {
        cooldown = tier.cooldown;
      }
    }
  }
}

writeFileSync(planPath, JSON.stringify(plan, null, 2));

const designed = plan.filter((p) => p.source === "designed").length;
console.log(`UPGRADE REPAIR PLAN — ${plan.length} tier(s)\n`);
console.log(`  ${designed} from the designed pre-balance ratio`);
console.log(`  ${plan.length - designed} from the house median (no usable original)\n`);
console.log(
  `  ${"ability".padEnd(20)} ${"lv".padStart(2)} ${"field".padEnd(8)} ${"replaces".padStart(8)} ${"was".padStart(8)} ${"becomes".padStart(8)}  ratio`,
);
for (const p of plan) {
  console.log(
    `  ${p.ability.padEnd(20)} ${String(p.level).padStart(2)} ${p.field.padEnd(8)} ` +
      `${String(p.replaces).padStart(8)} ${String(p.was).padStart(8)} ${String(p.becomes).padStart(8)}  ` +
      `x${p.ratio}${p.source === "house-median" ? " (median)" : ""}`,
  );
}
console.log(`\nwrote ${planPath}`);
