import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { botCastleFor, COSMETICS } from "../src/data/cosmetics.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";

/**
 * What a bot wears.
 *
 * ⚠️ A BROKEN DISTRIBUTION IS SILENT. Every bot still gets a castle, so the
 * only symptom of getting this wrong is "the skins feel off", which nobody
 * reports and nobody can act on. The odds are asserted over a large sample
 * instead — and they can be, because the roll is a pure function of a seed
 * rather than of `Math.random`.
 */

/** A kingdom with a full set, so the roll actually fires. */
const FULL = "time";

/**
 * …and one that is still short of a full set, so it must not.
 *
 * ⚠️ DERIVED, NOT NAMED. This was hardcoded to "space", and the test broke the
 * day Space got its fourth castle — the fixture went stale because shipping
 * skins is the normal thing to do to it. Asking KINGDOM_IDS which kingdom is
 * still incomplete keeps the case alive as the roster fills in.
 */
const PARTIAL =
  KINGDOM_IDS.find((id) => {
    const set = COSMETICS.filter(
      (c) => c.slot === "castle" && c.kingdomId === id && c.rarity !== "common",
    );
    return (
      set.filter((c) => c.rarity === "rare").length < 2 ||
      set.filter((c) => c.rarity === "legendary").length < 1
    );
  }) ?? null;

function tally(kingdomId: string, n = 40_000) {
  const counts = { default: 0, uncommon: 0, rare: 0, legendary: 0 };
  const byId = new Map<string, number>();
  for (let seed = 0; seed < n; seed++) {
    const item = botCastleFor(kingdomId, seed);
    if (!item) counts.default++;
    else {
      counts[item.rarity as "uncommon" | "rare" | "legendary"]++;
      byId.set(item.id, (byId.get(item.id) ?? 0) + 1);
    }
  }
  return { counts, byId, n };
}

/** Percentage points, so the assertions read like the spec. */
const pct = (part: number, total: number) => (part / total) * 100;

describe("bot castle skins", () => {
  test("a kingdom without a full set always gets the default", (t) => {
    // Once every kingdom has a full set there is no case left to test here,
    // and that is a success rather than a failure. The unknown-kingdom test
    // below still covers the other half of the guard.
    if (!PARTIAL) return t.skip("every kingdom has a full set");
    for (let seed = 0; seed < 500; seed++) {
      assert.equal(botCastleFor(PARTIAL, seed), undefined);
    }
  });

  test("an unknown kingdom is the default, not a crash", () => {
    assert.equal(botCastleFor("not-a-kingdom", 7), undefined);
  });

  test("the tier split is 25 / 25 / 40 / 10", () => {
    const { counts, n } = tally(FULL);
    // Two points of slack: this is a hash, not a uniform generator, and pinning
    // it tighter would make the test fail on an unrelated change to the seed.
    assert.ok(Math.abs(pct(counts.default, n) - 25) < 2, `default ${pct(counts.default, n)}`);
    assert.ok(Math.abs(pct(counts.uncommon, n) - 25) < 2, `uncommon ${pct(counts.uncommon, n)}`);
    assert.ok(Math.abs(pct(counts.rare, n) - 40) < 2, `rare ${pct(counts.rare, n)}`);
    assert.ok(Math.abs(pct(counts.legendary, n) - 10) < 2, `legendary ${pct(counts.legendary, n)}`);
  });

  test("a tier's chance is split evenly between the skins in it", () => {
    const { byId, n } = tally(FULL);
    const rares = COSMETICS.filter(
      (c) => c.slot === "castle" && c.kingdomId === FULL && c.rarity === "rare",
    );
    assert.equal(rares.length, 2, "fixture assumption: two rares");
    // 40% over two rares is 20% each — the exact example in the brief.
    for (const r of rares) {
      const share = pct(byId.get(r.id) ?? 0, n);
      assert.ok(Math.abs(share - 20) < 2, `${r.id} at ${share}%`);
    }
  });

  test("the same seed always gives the same skin", () => {
    // The whole point: this runs while building the snapshot each player gets,
    // so seven clients must land on the same castle for the same bot.
    for (const seed of [0, 1, 42, 99991, 2 ** 31]) {
      assert.equal(botCastleFor(FULL, seed)?.id, botCastleFor(FULL, seed)?.id);
    }
  });

  test("different seeds do not all give the same skin", () => {
    // Guards the failure where tier and skin are drawn off one number and a
    // pool only ever yields its first entry.
    const seen = new Set<string | undefined>();
    for (let seed = 0; seed < 2000; seed++) seen.add(botCastleFor(FULL, seed)?.id);
    assert.ok(seen.size >= 5, `only ${seen.size} distinct outcomes`);
  });
});
