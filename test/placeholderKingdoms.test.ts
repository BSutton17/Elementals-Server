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

// Joker, Light, and Dark ship with placeholder kits. Their real abilities are
// still to be designed, but the wiring must already be complete: selectable in
// the lobby, a full ability set that resolves through the registry, prices the
// HUD can render, and a castable path that lands damage. These tests pin the
// wiring — not the (deliberately generic) magnitudes, which will all change.

const PLACEHOLDER_KINGDOMS = ["joker", "light", "dark"] as const;

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
    // Its passive list exists (empty until the kingdom is designed) — the
    // engine's passive helpers all read through it, so a missing key would
    // break every one of them.
    assert.deepEqual(KINGDOM_PASSIVES[kingdom], []);
  });

  test(`${kingdom} has a full five-ability kit, all registered`, () => {
    const abilities = abilitiesForKingdom(kingdom);
    assert.equal(abilities.length, 5);
    assert.deepEqual(
      abilities.map((a) => a.kind),
      ["attack", "attack", "attack", "utility", "ultimate"],
    );
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
    for (const p of Object.values(prices)) {
      assert.ok(p.cast > 0);
      assert.ok(p.unlock !== null && p.unlock > 0); // all locked at start
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

  test(`${kingdom}'s utility applies its self buff`, () => {
    const { match, a } = activeMatch(kingdom);
    const utility = abilitiesForKingdom(kingdom).find((x) => x.kind === "utility")!;
    earn(a, 100_000);
    assert.equal(unlockOrUpgradeAbility(match, a, utility.id).ok, true);

    const result = activateAbility(match, a, utility, { forceCrit: false });
    assert.equal(result.ok, true, `${utility.id} failed: ${JSON.stringify(result)}`);
    assert.ok(a.statuses.some((s) => s.id === utility.id), "no self buff applied");
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
