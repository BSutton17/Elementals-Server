import { writeFileSync } from "node:fs";
import { register } from "tsx/esm/api";

/**
 * Dumps every ability's upgrade ladder as raw numbers.
 *
 *   node scripts/dumpLadders.mjs <registryPath> <out.json>
 *
 * Run against the CURRENT data and against a pre-balance copy, so the designed
 * ratios can be recovered and reapplied to the new bases.
 */
register();
const [, , registryPath, outPath] = process.argv;
const { ALL_ABILITIES } = await import(registryPath);

const out = {};
for (const a of Object.values(ALL_ABILITIES)) {
  out[a.id] = {
    baseAmount: a.effects?.[0]?.params?.amount ?? null,
    baseCooldown: a.cooldownTicks ?? null,
    tiers: (a.upgradePath ?? []).map((t) => ({
      level: t.level,
      amount: t.changes?.effectParams?.[0]?.amount ?? null,
      cooldown: t.changes?.cooldownTicks ?? null,
    })),
  };
}
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${Object.keys(out).length} abilities to ${outPath}`);
