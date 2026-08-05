import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { abilityPrices } from "../src/net/gameSync.js";
import { earn } from "../src/engine/money.js";
import { KINGDOM_IDS, KINGDOM_PASSIVES, isKingdomId } from "../src/data/kingdoms.js";
import { abilitiesForKingdom } from "../src/data/kingdomAbilities.js";
import { ALL_ABILITIES } from "../src/data/abilitiesRegistry.js";
import type { MatchPlayer } from "../src/match/types.js";

// Joker, Light, and Dark were added as placeholders. Their passives are all
// real (newKingdomPassives.test.ts) and all three kits are now fully designed
// — see the per-kingdom test files for the real behaviour.
//
// Whatever the design state, the WIRING must be complete for all three:
// selectable in the lobby, a full ability set that resolves through the
// registry, prices the HUD can render, and a castable path that lands damage.
// These tests pin that wiring — not the magnitudes, which will all change.

/** The kingdoms added as placeholders — all fully WIRED, whatever the state of
 *  their kit design. */
const PLACEHOLDER_KINGDOMS = ["joker", "light", "dark", "kitsune", "magma"] as const;

/**
 * The slots still filled by generic stand-ins, as `[kingdom, abilityId]`.
 * Joker, Light and Dark are fully designed; Kitsune is brand new and every
 * slot is still a stand-in. Remove entries here as its real kit lands.
 */
const PLACEHOLDER_SLOTS: readonly (readonly [string, string])[] = [
  // Kitsune's kit is fully designed — see kitsuneKingdom.test.ts.
  // Magma's kit is fully designed — see magmaKingdom.test.ts.
];

/**
 * Kingdoms whose PASSIVES are not designed yet — an empty entry in
 * `KINGDOM_PASSIVES` is the honest state for those, rather than two inert
 * stand-ins that look wired and do nothing. Empty today: every kingdom's
 * passives are real (Kitsune's and Magma's behaviour is pinned in
 * newKingdomPassives.test.ts). Add a kingdom back if one ships without them.
 */
const PASSIVES_PENDING: readonly string[] = [];

const matchPlayer = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: ["sharperSwords", "extraGuards"],
  ready: true,
  connected: true,
});

function activeMatch(kingdomId: string) {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", kingdomId));
  match.addPlayer(matchPlayer("b", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  return {
    match,
    a: match.gameState!.getPlayer("a")!,
    b: match.gameState!.getPlayer("b")!,
  };
}

for (const kingdom of PLACEHOLDER_KINGDOMS) {
  test(`${kingdom} is a selectable kingdom with declared passives`, () => {
    assert.ok(isKingdomId(kingdom));
    assert.ok((KINGDOM_IDS as readonly string[]).includes(kingdom));
    // Its passives are designed and wired (behaviour is pinned in
    // newKingdomPassives.test.ts) — only the ABILITY kit below is a
    // placeholder. Every finished kingdom carries exactly two.
    const passives = KINGDOM_PASSIVES[kingdom];
    assert.ok(Array.isArray(passives), "no passive list is declared at all");
    if (PASSIVES_PENDING.includes(kingdom)) {
      // Not yet designed: empty is the honest state, and the engine treats it
      // as "nothing applies" rather than erroring.
      assert.equal(passives.length, 0);
    } else {
      assert.equal(passives.length, 2);
    }
  });

  test(`${kingdom} has a full five-ability kit, all registered`, () => {
    const abilities = abilitiesForKingdom(kingdom);
    assert.equal(abilities.length, 5);
    // Most kits run three attacks, but that is a convention rather than a rule:
    // Magma runs two plus two support abilities, both offensive in intent but
    // neither dealing damage the way an attack does. What the ENGINE actually
    // requires is pinned instead.
    const kinds = abilities.map((a) => a.kind);
    assert.equal(kinds[0], "attack", "slot 1 must be the basic attack");
    assert.equal(kinds[4], "ultimate", "slot 5 must be the ultimate");
    assert.equal(
      kinds.filter((k) => k === "ultimate").length,
      1,
      "a kingdom has exactly one ultimate",
    );
    assert.equal(kinds.includes("passive"), false, "passives are not castable");
    for (const ability of abilities) {
      // Registered by id — `cooldownModify`, purchases, and the sync all look
      // abilities up here, so an unregistered one is invisible to the engine.
      assert.equal(ALL_ABILITIES[ability.id], ability, `${ability.id} not registered`);
      assert.ok(ability.upgradePath && ability.upgradePath.length > 0);
    }
  });

  test(`${kingdom} reports a complete price table to the HUD`, () => {
    const { a } = activeMatch(kingdom);
    const prices = abilityPrices(a);
    assert.deepEqual(
      Object.keys(prices).sort(),
      abilitiesForKingdom(kingdom).map((x) => x.id).sort(),
    );
    for (const [id, p] of Object.entries(prices)) {
      // A cast price of 0 is legal for an ability paid for in something other
      // than gold (Kitsune Rush spends a full Ancient Memory meter). Every
      // ability still has to be UNLOCKED, so that price is always real.
      assert.ok(p.cast >= 0, `${id} has a negative cast price`);
      assert.ok(p.unlock !== null && p.unlock > 0, `${id} has no unlock price`);
    }
  });

  test(`${kingdom} can buy, upgrade, and cast its basic attack`, () => {
    const { match, a, b } = activeMatch(kingdom);
    const basic = abilitiesForKingdom(kingdom)[0]!;
    earn(a, 100_000);

    assert.equal(unlockOrUpgradeAbility(match, a, basic.id).ok, true);
    assert.equal(a.unlocked[basic.id], true);
    assert.equal(unlockOrUpgradeAbility(match, a, basic.id).ok, true);
    assert.equal(a.upgrades[basic.id], 1);

    a.target = b.id;
    const hpBefore = b.castle.hp;
    const result = activateAbility(match, a, basic, { forceCrit: false });
    assert.equal(result.ok, true, `${basic.id} failed: ${JSON.stringify(result)}`);
    assert.ok(b.castle.hp < hpBefore, "the basic attack dealt no damage");
  });

}

for (const [kingdom, abilityId] of PLACEHOLDER_SLOTS) {
  test(`${kingdom}'s ${abilityId} placeholder still casts and lands`, () => {
    const { match, a, b } = activeMatch(kingdom);
    const ability = abilitiesForKingdom(kingdom).find((x) => x.id === abilityId);
    assert.ok(ability, `${abilityId} is no longer in ${kingdom}'s kit — update PLACEHOLDER_SLOTS`);
    earn(a, 100_000);
    assert.equal(unlockOrUpgradeAbility(match, a, ability!.id).ok, true);

    a.target = b.id;
    const hpBefore = b.castle.hp;
    const result = activateAbility(match, a, ability!, { forceCrit: false });
    assert.equal(result.ok, true, `${abilityId} failed: ${JSON.stringify(result)}`);

    if (ability!.kind === "utility") {
      // A self-buff lands a status on its caster rather than damage — asserting
      // damage here would pass only by accident of what the stand-in happens
      // to do.
      assert.ok(a.statuses.length > 0, `${abilityId} applied no status`);
      assert.equal(b.castle.hp, hpBefore, `${abilityId} damaged its caster's target`);
    } else {
      assert.ok(b.castle.hp < hpBefore, `${abilityId} dealt no damage`);
    }
  });
}

test("every kingdom id has an ability set and a passive list", () => {
  // Guards the next kingdom too: adding an id without wiring it up fails here
  // rather than at runtime, mid-match.
  for (const id of KINGDOM_IDS) {
    assert.equal(abilitiesForKingdom(id).length, 5, `${id} has no full kit`);
    assert.ok(KINGDOM_PASSIVES[id] !== undefined, `${id} has no passive list`);
  }
});

test("no two abilities share an id across all kingdoms", () => {
  const ids = KINGDOM_IDS.flatMap((k) => abilitiesForKingdom(k).map((a) => a.id));
  assert.equal(new Set(ids).size, ids.length, "duplicate ability id across kingdoms");
});
