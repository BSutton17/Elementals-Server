import { COSMETICS, purchasable, type CosmeticItem } from "../data/cosmetics.js";
import { KINGDOM_IDS } from "../data/kingdoms.js";

/**
 * What is on sale, and when.
 *
 * Two sections inside one shop:
 *
 *   DAILY     every uncommon, always. Plus ONE of each kingdom's two rares,
 *             rotating weekly.
 *   FEATURED  two legendaries and two rares, refreshed daily. The only place a
 *             legendary can be bought. Its rare slots are filled from the rares
 *             that are BENCHED on Daily this week — so the half of the rare
 *             catalogue Daily is not showing still has a way to appear.
 *
 * Deterministic: the same day produces the same shop for everybody, computed
 * from the date rather than stored. Nothing has to be written down, a restart
 * cannot reroll it, and two players comparing screens see the same thing —
 * which matters in a game people play in the same room.
 */

/** A small deterministic hash. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Seeded generator — `mulberry32`, as elsewhere in the engine. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates against a seeded stream, so a shuffle is reproducible. */
function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The week a quest day belongs to, as a stable key.
 *
 * Rares rotate weekly while Featured rotates daily, so the two need different
 * seeds. Derived from the day string so both share one calendar and cannot
 * drift apart.
 */
export function storeWeek(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const days = Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000);
  // ⚠️ +3 ANCHORS THE WEEK TO MONDAY. Unix day 0 is a Thursday, so a bare
  // `days / 7` would rotate the rares on a Thursday — stable, but arbitrary,
  // and impossible to explain to a player. Weeks now run Monday to Sunday and
  // flip at the same 10:00 CT boundary the daily reset uses, because this is
  // derived from the quest day rather than from raw UTC.
  return `w${Math.floor((days + 3) / 7)}`;
}

/**
 * Splits each kingdom's rares into the one Daily shows this week and the ones
 * it does not.
 *
 * ⚠️ THE BENCHED RARES ARE NOT DISCARDED. They are exactly the pool Featured
 * draws its two rare slots from, so every rare in the catalogue is reachable
 * within a week or two rather than half of them being invisible.
 */
export function splitRares(week: string): { onDaily: CosmeticItem[]; benched: CosmeticItem[] } {
  const onDaily: CosmeticItem[] = [];
  const benched: CosmeticItem[] = [];

  for (const kingdomId of KINGDOM_IDS) {
    const rares = purchasable().filter(
      (item) => item.rarity === "rare" && item.kingdomId === kingdomId,
    );
    if (rares.length === 0) continue;

    const next = rng(hash(`${week}:${kingdomId}`));
    const order = shuffled(rares, next);
    onDaily.push(order[0]!);
    benched.push(...order.slice(1));
  }

  return { onDaily, benched };
}

export interface StoreFront {
  day: string;
  week: string;
  featured: CosmeticItem[];
  daily: CosmeticItem[];
}

/** How many of each go in Featured. */
export const FEATURED = { legendary: 2, rare: 2 } as const;

/**
 * The shop for one day.
 *
 * Featured is seeded on the DAY (it refreshes every morning); the rare split is
 * seeded on the WEEK (it holds for seven days). Both are pure functions of the
 * date, so this is the same for every player and needs no storage.
 */
export function storeFront(day: string): StoreFront {
  const week = storeWeek(day);
  const { onDaily, benched } = splitRares(week);

  const legendaries = purchasable().filter((item) => item.rarity === "legendary");
  const featuredLegendary = shuffled(legendaries, rng(hash(`${day}:legendary`))).slice(
    0,
    FEATURED.legendary,
  );

  // Featured's rare slots come from what Daily benched this week — never from
  // what Daily is already showing, or the same item would sit in both sections.
  const featuredRare = shuffled(benched, rng(hash(`${day}:rare`))).slice(0, FEATURED.rare);

  const uncommons = purchasable().filter((item) => item.rarity === "uncommon");

  return {
    day,
    week,
    featured: [...featuredLegendary, ...featuredRare],
    // Uncommons are ALWAYS present — they are the reliable floor of the shop —
    // with the week's rare on top.
    daily: [...uncommons, ...onDaily],
  };
}

/** Whether an item may be bought today. Guards the purchase path. */
export function isOnSale(item: CosmeticItem, day: string): boolean {
  if (item.isDefault) return false;
  const front = storeFront(day);
  return (
    front.featured.some((i) => i.id === item.id) ||
    front.daily.some((i) => i.id === item.id)
  );
}

/** Everything in the catalogue, for a collection view. */
export function catalogue(): CosmeticItem[] {
  return COSMETICS;
}
