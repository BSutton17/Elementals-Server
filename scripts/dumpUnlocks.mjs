import { writeFileSync } from "node:fs";
import { register } from "tsx/esm/api";
/**
 * Snapshots every ability's EFFECTIVE unlock price.
 *
 *   node scripts/dumpUnlocks.mjs <out.json>
 *
 * Taken before and after making `unlockCost` explicit, so the change can be
 * proven behaviour-neutral: writing down the number the game already computes
 * must not move a single price.
 */
register();
const { KINGDOM_IDS } = await import("../src/data/kingdoms.ts");
const { abilitiesForKingdom } = await import("../src/data/kingdomAbilities.ts");
const out = {};
for (const k of KINGDOM_IDS) {
  for (const a of abilitiesForKingdom(k)) {
    out[a.id] = {
      cost: a.cost,
      explicit: a.unlockCost ?? null,
      effective: a.unlockCost ?? Math.ceil(a.cost * 0.5),
    };
  }
}
writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
console.log(`wrote ${Object.keys(out).length} abilities`);
