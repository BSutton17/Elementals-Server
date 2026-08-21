import { register } from "tsx/esm/api";

/**
 * What does a HEALTHY upgrade step look like in this game?
 *
 *   node scripts/analyzeUpgradeSteps.mjs
 *
 * The 43 broken tiers have to be repaired to something, and that something
 * should be the game's own design language rather than a number invented for
 * the occasion. So: measure every tier that still improves on the value it
 * replaces, and report the distribution of those steps.
 *
 * Damage tiers are reported as a multiplier above what they replace; cooldown
 * tiers as a multiplier below. The medians are the house style.
 */

register();
const { ALL_ABILITIES } = await import("../src/data/abilitiesRegistry.ts");

const damageSteps = [];
const cooldownSteps = [];

for (const ability of Object.values(ALL_ABILITIES)) {
  let amount = ability.effects?.[0]?.params?.amount;
  let cooldown = ability.cooldownTicks;

  for (const tier of ability.upgradePath ?? []) {
    const nextAmount = tier.changes?.effectParams?.[0]?.amount;
    if (typeof nextAmount === "number" && typeof amount === "number" && amount > 0) {
      if (nextAmount > amount) damageSteps.push(nextAmount / amount);
      amount = nextAmount;
    }
    const nextCd = tier.changes?.cooldownTicks;
    if (typeof nextCd === "number" && typeof cooldown === "number" && cooldown > 0) {
      if (nextCd < cooldown) cooldownSteps.push(nextCd / cooldown);
      cooldown = nextCd;
    }
  }
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    min: s[0],
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    max: s[s.length - 1],
  };
};

const fmt = (o) =>
  `n=${o.n}  min ${o.min?.toFixed(3)}  p25 ${o.p25?.toFixed(3)}  MEDIAN ${o.median?.toFixed(3)}  p75 ${o.p75?.toFixed(3)}  max ${o.max?.toFixed(3)}`;

console.log("HEALTHY UPGRADE STEPS (tiers that still improve on what they replace)\n");
console.log(`  damage   multiplier above replaced: ${fmt(stats(damageSteps))}`);
console.log(`  cooldown multiplier below replaced: ${fmt(stats(cooldownSteps))}`);
console.log(
  `\n  => repair broken damage tiers to replaced x ${stats(damageSteps).median?.toFixed(3)}`,
);
console.log(
  `  => repair broken cooldown tiers to replaced x ${stats(cooldownSteps).median?.toFixed(3)}`,
);
