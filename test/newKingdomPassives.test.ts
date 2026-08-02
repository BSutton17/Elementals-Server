import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { createPlayerState, type PlayerState } from "../src/match/playerState.js";
import { activateAbility, purchaseUpgrade } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility, buyShield } from "../src/engine/purchases.js";
import { abilityPrices } from "../src/net/gameSync.js";
import { setCooldown, getCooldown } from "../src/engine/cooldowns.js";
import { resolveDamage } from "../src/engine/damage.js";
import { earn } from "../src/engine/money.js";
import { abilitiesForKingdom } from "../src/data/kingdomAbilities.js";
import { PERKS, COMBAT, TICK } from "../src/data/balance.js";
import type { PerkId } from "../src/data/perks.js";
import type { MatchPlayer } from "../src/match/types.js";

// The designed passives for Joker, Light, and Dark. (Their ability KITS are
// still placeholders — see placeholderKingdoms.test.ts.)

const matchPlayer = (
  id: string,
  kingdomId: string,
  perks: PerkId[] = [],
): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks,
  ready: true,
  connected: true,
});

function activeMatch(kingdomA: string, perksA: PerkId[] = [], kingdomB = "water") {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", kingdomA, perksA));
  match.addPlayer(matchPlayer("b", kingdomB));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  return {
    match,
    a: match.gameState!.getPlayer("a")!,
    b: match.gameState!.getPlayer("b")!,
  };
}

// ---------------------------------------------------------------------------
// Light — "Speed of light" / "Bright idea"
// ---------------------------------------------------------------------------

test("Speed of light: casting shortens every OTHER ability's cooldown", () => {
  const { match, a, b } = activeMatch("light");
  const [first, second, third] = abilitiesForKingdom("light");
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, first!.id).ok, true);
  a.target = b.id;

  setCooldown(a, second!.id, 100);
  setCooldown(a, third!.id, 40);

  assert.equal(activateAbility(match, a, first!, { forceCrit: false }).ok, true);

  // Each other cooldown dropped by 1.5 seconds' worth of ticks...
  const hurry = 1.5 * TICK.RATE;
  assert.equal(getCooldown(a, second!.id), 100 - hurry);
  assert.equal(getCooldown(a, third!.id), 40 - hurry);
  // ...and the cast ability's OWN freshly-armed cooldown was left alone.
  assert.equal(getCooldown(a, first!.id), first!.cooldownTicks);
});

test("Speed of light clears a cooldown it overshoots rather than going negative", () => {
  const { match, a, b } = activeMatch("light");
  const [first, second] = abilitiesForKingdom("light");
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, first!.id).ok, true);
  a.target = b.id;

  setCooldown(a, second!.id, 5); // less than the 1.5 s reduction
  assert.equal(activateAbility(match, a, first!, { forceCrit: false }).ok, true);
  assert.equal(getCooldown(a, second!.id), 0);
});

test("Speed of light leaves other kingdoms' cooldowns untouched", () => {
  const { match, a, b } = activeMatch("water");
  const [first, second] = abilitiesForKingdom("water");
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, first!.id).ok, true);
  a.target = b.id;

  setCooldown(a, second!.id, 100);
  assert.equal(activateAbility(match, a, first!, { forceCrit: false }).ok, true);
  assert.equal(getCooldown(a, second!.id), 100);
});

test("Bright idea: upgrade tiers cost less, in the charge AND the quoted price", () => {
  const plain = activeMatch("water");
  const lit = activeMatch("light");
  const waterAbility = abilitiesForKingdom("water")[0]!;
  const lightAbility = abilitiesForKingdom("light")[0]!;
  // Both kits use the same placeholder/base tier prices, so the discount is
  // visible as a straight comparison against an undiscounted kingdom.
  assert.equal(
    waterAbility.upgradePath![0]!.cost,
    lightAbility.upgradePath![0]!.cost,
    "fixture assumes both first tiers are priced the same",
  );
  const tierCost = lightAbility.upgradePath![0]!.cost;
  const expected = Math.ceil(tierCost * (1 - 0.2));

  for (const s of [plain, lit]) {
    earn(s.a, 100_000);
    const id = abilitiesForKingdom(s.a.kingdomId)[0]!.id;
    assert.equal(unlockOrUpgradeAbility(s.match, s.a, id).ok, true);
  }

  // The quoted next-upgrade price the HUD receives.
  assert.equal(abilityPrices(plain.a)[waterAbility.id]!.upgrade, tierCost);
  assert.equal(abilityPrices(lit.a)[lightAbility.id]!.upgrade, expected);

  // And what the purchase actually charges.
  const before = lit.a.economy.currency;
  assert.equal(purchaseUpgrade(lit.match, lit.a, lightAbility).ok, true);
  assert.equal(before - lit.a.economy.currency, expected);
});

test("Bright idea does not discount unlock prices — that is the perk's job", () => {
  const plain = activeMatch("water");
  const lit = activeMatch("light");
  assert.equal(
    abilityPrices(lit.a)[abilitiesForKingdom("light")[0]!.id]!.unlock,
    abilityPrices(plain.a)[abilitiesForKingdom("water")[0]!.id]!.unlock,
  );
});

// ---------------------------------------------------------------------------
// Dark — "Night terrors" / "Black Magic"
// ---------------------------------------------------------------------------

test("Night terrors: attacking Dark can blacken the attacker's own screen", () => {
  const { match, a, b } = activeMatch("water", [], "dark");
  const attack = abilitiesForKingdom("water")[0]!;
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, attack.id).ok, true);
  a.target = b.id;

  // rng() = 0 always clears the 20% retaliation roll.
  assert.equal(
    activateAbility(match, a, attack, { forceCrit: false, rng: () => 0 }).ok,
    true,
  );
  const mark = a.statuses.find((s) => s.id === "darkened");
  assert.ok(mark, "the attacker was not darkened");
  assert.equal(mark!.sourceId, b.id);
  // The victim of the blackout is the ATTACKER, never Dark itself.
  assert.equal(b.statuses.some((s) => s.id === "darkened"), false);
});

test("Night terrors does not fire when the roll fails", () => {
  const { match, a, b } = activeMatch("water", [], "dark");
  const attack = abilitiesForKingdom("water")[0]!;
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, attack.id).ok, true);
  a.target = b.id;

  // rng() = 0.99 fails the 20% roll.
  assert.equal(
    activateAbility(match, a, attack, { forceCrit: false, rng: () => 0.99 }).ok,
    true,
  );
  assert.equal(a.statuses.some((s) => s.id === "darkened"), false);
});

test("Black Magic: Dark's perks run at their boosted magnitudes", () => {
  const plain = activeMatch("water", ["sharperSwords", "extraGuards"]);
  const dark = activeMatch("dark", ["sharperSwords", "extraGuards"]);
  const opts = { forceCrit: false as const };

  // Sharper Swords: 10% base -> 15% boosted (outgoing).
  const base = resolveDamage(plain.a, plain.b, 1000, opts).amount;
  const boosted = resolveDamage(dark.a, dark.b, 1000, opts).amount;
  assert.equal(base, Math.round(1000 * (1 + PERKS.ATTACK_PCT)));
  assert.equal(boosted, Math.round(1000 * (1 + PERKS.ATTACK_PCT_BOOSTED)));

  // Extra Guards: 10% base -> 15% boosted (incoming, Dark as the defender).
  const incoming = resolveDamage(dark.b, dark.a, 1000, opts).amount;
  assert.equal(incoming, Math.round(1000 * (1 - PERKS.DAMAGE_REDUCTION_PCT_BOOSTED)));
});

test("Black Magic boosts the perks that pay out at match start", () => {
  const config = createMatchConfig(new Match("1234"));
  const perks: PerkId[] = ["deepPockets", "betterConstruction"];
  const water = createPlayerState({ id: "w", name: "w", kingdomId: "water", perks }, config);
  const dark = createPlayerState({ id: "d", name: "d", kingdomId: "dark", perks }, config);

  assert.equal(water.economy.currency, PERKS.STARTING_GOLD);
  assert.equal(dark.economy.currency, PERKS.STARTING_GOLD_BOOSTED);
});

test("Black Magic boosts Better Construction on a purchased shield", () => {
  const plain = activeMatch("water", ["betterConstruction", "extraGuards"]);
  const dark = activeMatch("dark", ["betterConstruction", "extraGuards"]);
  for (const s of [plain, dark]) {
    earn(s.a, 100_000);
    assert.equal(buyShield(s.match, s.a).ok, true);
  }
  assert.equal(
    dark.a.castle.shield - plain.a.castle.shield,
    PERKS.SHIELD_BONUS_HP_BOOSTED - PERKS.SHIELD_BONUS_HP,
  );
});

test("Black Magic does nothing for perks the player did not pick", () => {
  const dark = activeMatch("dark", ["extraGuards", "extraMedics"]);
  // No Sharper Swords → no outgoing bonus at all, boosted or otherwise.
  const dealt = resolveDamage(dark.a, dark.b, 1000, { forceCrit: false }).amount;
  assert.equal(dealt, 1000);
});

// ---------------------------------------------------------------------------
// Joker — "Beginners luck" / "Why so serious?"
// ---------------------------------------------------------------------------

test("Beginners luck: Joker crits at double the base chance", () => {
  const { a, b } = activeMatch("joker");
  const plain = activeMatch("water");
  const doubled = COMBAT.BASE_CRIT_CHANCE * 2;

  // A roll just under the doubled chance crits for Joker but not for Water.
  const rng = () => doubled - 0.001;
  assert.equal(resolveDamage(a, b, 1000, { rng }).crit, true);
  assert.equal(resolveDamage(plain.a, plain.b, 1000, { rng }).crit, false);

  // A roll above the doubled chance still misses for Joker.
  assert.equal(resolveDamage(a, b, 1000, { rng: () => doubled + 0.001 }).crit, false);
});

test("Why so serious?: attacks on a shielded Joker can miss entirely", () => {
  const { match, a, b } = activeMatch("water", [], "joker");
  const attack = abilitiesForKingdom("water")[0]!;
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, attack.id).ok, true);
  a.target = b.id;
  b.castle.shield = 5_000;

  const hpBefore = b.castle.hp;
  const shieldBefore = b.castle.shield;
  // rng() = 0 clears the 5% miss roll.
  assert.equal(
    activateAbility(match, a, attack, { forceCrit: false, rng: () => 0 }).ok,
    true,
  );
  assert.equal(b.castle.shield, shieldBefore, "a missed attack still hit the shield");
  assert.equal(b.castle.hp, hpBefore);
});

test("Why so serious? does nothing while Joker is unshielded", () => {
  const { match, a, b } = activeMatch("water", [], "joker");
  const attack = abilitiesForKingdom("water")[0]!;
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, attack.id).ok, true);
  a.target = b.id;
  assert.equal(b.castle.shield, 0);

  const hpBefore = b.castle.hp;
  assert.equal(
    activateAbility(match, a, attack, { forceCrit: false, rng: () => 0 }).ok,
    true,
  );
  assert.ok(b.castle.hp < hpBefore, "an unshielded Joker dodged an attack");
});

test("Why so serious? lets attacks through when the roll fails", () => {
  const { match, a, b } = activeMatch("water", [], "joker");
  const attack = abilitiesForKingdom("water")[0]!;
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, attack.id).ok, true);
  a.target = b.id;
  b.castle.shield = 5_000;

  const shieldBefore = b.castle.shield;
  // rng() = 0.99 fails the 5% roll.
  assert.equal(
    activateAbility(match, a, attack, { forceCrit: false, rng: () => 0.99 }).ok,
    true,
  );
  assert.ok(b.castle.shield < shieldBefore, "the attack was wrongly dodged");
});
