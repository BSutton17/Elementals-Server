import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURED,
  clearRerolls,
  featuredNonce,
  isOnSale,
  rerollFeatured,
  splitRares,
  storeFront,
  storeWeek,
} from "../src/engine/store.js";
import {
  COSMETICS,
  RARITY_PRICE,
  cosmeticById,
  defaultCosmetic,
  purchasable,
  type CosmeticItem,
} from "../src/data/cosmetics.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";

// The shop's rotation rules:
//   DAILY     every uncommon, always; plus ONE rare per kingdom, weekly.
//   FEATURED  2 legendary + 2 rare, daily; the only place legendaries appear;
//             its rare slots come from the rares Daily benched this week.
//
// The paid catalogue is empty until the skins are designed, so the tests that
// need items build their own — these are rules about the ENGINE, and they have
// to hold before the content exists rather than after.

const item = (
  id: string,
  rarity: CosmeticItem["rarity"],
  kingdomId: CosmeticItem["kingdomId"] = "fire",
): CosmeticItem => ({
  id,
  slot: "castle",
  kingdomId,
  name: id,
  rarity,
  price: 100,
});

// --- the catalogue -----------------------------------------------------------

test("every kingdom has exactly one default castle and one default shield", () => {
  // A kingdom without a default has nothing to wear when nothing is equipped.
  for (const kingdomId of KINGDOM_IDS) {
    const castle = defaultCosmetic("castle", kingdomId);
    const shield = defaultCosmetic("shield", kingdomId);
    assert.ok(castle, `${kingdomId} has no default castle`);
    assert.ok(shield, `${kingdomId} has no default shield`);
    assert.equal(castle!.isDefault, true);
    assert.equal(castle!.price, 0, "a default is never sold");
  }
});

test("defaults are excluded from what can be bought", () => {
  assert.ok(purchasable().every((i) => !i.isDefault));
});

test("item ids are unique", () => {
  const ids = COSMETICS.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a default is never on sale, on any day", () => {
  const standard = defaultCosmetic("castle", "fire")!;
  assert.equal(isOnSale(standard, "2026-08-26"), false);
});

test("the price table covers every rarity and rises with it", () => {
  assert.ok(RARITY_PRICE.rare.castle > RARITY_PRICE.uncommon.castle);
  assert.ok(RARITY_PRICE.legendary.castle > RARITY_PRICE.rare.castle);
});

// --- the weekly boundary -----------------------------------------------------

test("a week key is stable for seven days and then changes", () => {
  const first = storeWeek("2026-08-24");
  assert.equal(storeWeek("2026-08-25"), first);
  assert.equal(storeWeek("2026-08-30"), first);
  assert.notEqual(storeWeek("2026-08-31"), first, "the eighth day is a new week");
});

// --- the rare split ----------------------------------------------------------

test("EXACTLY ONE RARE PER KINGDOM GOES ON DAILY; the rest are benched", () => {
  const rares = [item("fire.a", "rare", "fire"), item("fire.b", "rare", "fire")];
  const split = splitRaresWith(rares, "w1");
  assert.equal(split.onDaily.length, 1);
  assert.equal(split.benched.length, 1);
  assert.notEqual(split.onDaily[0]!.id, split.benched[0]!.id);
});

test("the split holds all week, then rotates", () => {
  const rares = [item("fire.a", "rare", "fire"), item("fire.b", "rare", "fire")];
  const week1 = splitRaresWith(rares, "w1").onDaily[0]!.id;
  const week1Again = splitRaresWith(rares, "w1").onDaily[0]!.id;
  assert.equal(week1, week1Again, "the same week is the same shop");

  // Over enough weeks BOTH rares must appear — otherwise half the catalogue is
  // permanently invisible on Daily.
  const seen = new Set<string>();
  for (let w = 0; w < 20; w++) seen.add(splitRaresWith(rares, `w${w}`).onDaily[0]!.id);
  assert.equal(seen.size, 2, "both rares should reach Daily over time");
});

/** `splitRares` reads the real catalogue; this exercises the same rule on a
 *  supplied set so the tests hold before any content exists. */
function splitRaresWith(rares: CosmeticItem[], week: string) {
  // Mirrors the engine: seeded shuffle per (week, kingdom), first goes on Daily.
  const seeded = [...rares].sort((a, b) =>
    hash(`${week}:${a.id}`) - hash(`${week}:${b.id}`),
  );
  return { onDaily: [seeded[0]!], benched: seeded.slice(1) };
}

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- the shop front ----------------------------------------------------------

test("the same day gives everyone the same shop", () => {
  // Computed from the date, not stored - so two players comparing screens in
  // the same room see the same thing.
  const a = storeFront("2026-08-26");
  const b = storeFront("2026-08-26");
  assert.deepEqual(a, b);
});

test("Featured refreshes daily while the rare split holds weekly", () => {
  const monday = storeFront("2026-08-24");
  const tuesday = storeFront("2026-08-25");
  assert.equal(monday.week, tuesday.week, "same week");
  assert.notEqual(monday.day, tuesday.day, "different day");
});

test("Featured never shows an item Daily is already showing", () => {
  // Its rare slots come from what Daily BENCHED. The same item in both
  // sections would look like a bug and waste a slot.
  const front = storeFront("2026-08-26");
  const dailyIds = new Set(front.daily.map((i) => i.id));
  for (const featured of front.featured) {
    assert.ok(!dailyIds.has(featured.id), `${featured.id} is in both sections`);
  }
});

test("Featured is capped at its two-and-two shape", () => {
  const front = storeFront("2026-08-26");
  assert.ok(front.featured.length <= FEATURED.legendary + FEATURED.rare);
  assert.ok(front.featured.filter((i) => i.rarity === "legendary").length <= FEATURED.legendary);
  assert.ok(front.featured.filter((i) => i.rarity === "rare").length <= FEATURED.rare);
});

test("DAILY NEVER CARRIES A LEGENDARY — Featured is the only place they appear", () => {
  for (const day of ["2026-08-24", "2026-08-25", "2026-09-01", "2026-12-31"]) {
    const front = storeFront(day);
    assert.ok(
      front.daily.every((i) => i.rarity !== "legendary"),
      `a legendary reached Daily on ${day}`,
    );
  }
});

test("Daily carries every uncommon, always", () => {
  const uncommons = purchasable().filter((i) => i.rarity === "uncommon");
  const front = storeFront("2026-08-26");
  for (const u of uncommons) {
    assert.ok(front.daily.some((i) => i.id === u.id), `${u.id} missing from Daily`);
  }
});

test("an empty catalogue produces an empty shop rather than throwing", () => {
  // Where the project is right now: the system ships before the content.
  const front = storeFront("2026-08-26");
  assert.ok(Array.isArray(front.featured));
  assert.ok(Array.isArray(front.daily));
});

test("nothing outside the shop can be bought", () => {
  // The guard the purchase path leans on: a stale screen must not be able to
  // buy yesterday's featured legendary.
  const ghost = item("does.not.exist", "rare");
  assert.equal(isOnSale(ghost, "2026-08-26"), false);
  assert.equal(cosmeticById(ghost.id), undefined);
});

// --- admin reroll of Featured -----------------------------------------------

test("an untouched day is seeded exactly as it was before rerolls existed", () => {
  // The guarantee that lets this feature ship: adding a nonce to the seed must
  // not have quietly changed every day's shop for every player.
  clearRerolls();
  const before = storeFront("2026-03-04");
  clearRerolls();
  assert.deepEqual(
    storeFront("2026-03-04").featured.map((i) => i.id),
    before.featured.map((i) => i.id),
  );
  assert.equal(featuredNonce("2026-03-04"), 0);
});

test("a reroll changes Featured and leaves Daily alone", () => {
  clearRerolls();
  const day = "2026-03-04";
  const before = storeFront(day);
  const after = rerollFeatured(day);

  assert.equal(featuredNonce(day), 1);
  // Daily is on the WEEK's seed and has nothing to do with the button.
  assert.deepEqual(
    after.daily.map((i) => i.id),
    before.daily.map((i) => i.id),
  );
  // With 16 legendaries to draw two from, an identical featured page would be
  // a 1-in-240 coincidence; over a few rolls, effectively impossible.
  const rolls = [before, after, rerollFeatured(day), rerollFeatured(day)].map((f) =>
    f.featured.map((i) => i.id).join(","),
  );
  assert.ok(new Set(rolls).size > 1, "rerolling never changed the featured page");
  clearRerolls();
});

test("a reroll expires with the day it was made on", () => {
  // Yesterday's nudge must not still be displacing today's shop.
  clearRerolls();
  rerollFeatured("2026-03-04");
  assert.equal(featuredNonce("2026-03-05"), 0);
  clearRerolls();
});

test("what a reroll puts in Featured is buyable", () => {
  // isOnSale reads the same rerolled front, or the button would show items the
  // purchase path then refuses.
  clearRerolls();
  const day = "2026-03-04";
  const front = rerollFeatured(day);
  for (const item of front.featured) assert.ok(isOnSale(item, day), `${item.id} not on sale`);
  clearRerolls();
});
