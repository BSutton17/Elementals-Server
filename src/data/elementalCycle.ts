import { KINGDOM_IDS, type KingdomId } from "./kingdoms.js";

/**
 * Who beats whom, for the "Elemental's Elementaled" room rule.
 *
 * Three closed rings. Reading `a → b` as "a has the advantage over b", each
 * kingdom is strong against exactly one other and weak to exactly one other,
 * and the rings wrap: the last entry beats the first.
 *
 *   water → fire → ice → nature → earth → air → electricity → (water)
 *   time → space → light → dark → love → (time)
 *   joker → kitsune → magma → insects → (joker)
 *
 * ⚠️ SEVEN, FIVE AND FOUR — SIXTEEN, WHICH IS EVERY KINGDOM EXACTLY ONCE. That
 * is the property the whole rule rests on: a kingdom in no ring would silently
 * play the mode with no matchup at all, and one in two rings would have two
 * answers to "who am I strong against". Neither would throw, and neither would
 * be visible from a match. `assertRings` checks it at module load, so a
 * seventeenth kingdom added without a ring fails the server on start-up rather
 * than a fortnight later.
 */
const RINGS: readonly (readonly KingdomId[])[] = [
  ["water", "fire", "ice", "nature", "earth", "air", "electricity"],
  ["time", "space", "light", "dark", "love"],
  ["joker", "kitsune", "magma", "insects"],
];

const strong = new Map<KingdomId, KingdomId>();
const weak = new Map<KingdomId, KingdomId>();

for (const ring of RINGS) {
  ring.forEach((kingdom, i) => {
    const next = ring[(i + 1) % ring.length]!;
    strong.set(kingdom, next);
    weak.set(next, kingdom);
  });
}

function assertRings(): void {
  const placed = RINGS.flat();
  const seen = new Set(placed);
  if (seen.size !== placed.length) {
    throw new Error("elementalCycle: a kingdom appears in more than one ring");
  }
  const missing = KINGDOM_IDS.filter((k) => !seen.has(k));
  if (missing.length > 0) {
    throw new Error(`elementalCycle: no ring contains ${missing.join(", ")}`);
  }
  const unknown = placed.filter((k) => !KINGDOM_IDS.includes(k));
  if (unknown.length > 0) {
    throw new Error(`elementalCycle: ${unknown.join(", ")} is not a kingdom`);
  }
}
assertRings();

/** The kingdom this one has the advantage over. */
export function strongAgainst(kingdom: KingdomId | null | undefined): KingdomId | null {
  return kingdom ? strong.get(kingdom) ?? null : null;
}

/** The kingdom that has the advantage over this one. */
export function weakAgainst(kingdom: KingdomId | null | undefined): KingdomId | null {
  return kingdom ? weak.get(kingdom) ?? null : null;
}

/** Whether `attacker` holds the advantage over `defender`. */
export function hasAdvantage(
  attacker: KingdomId | null | undefined,
  defender: KingdomId | null | undefined,
): boolean {
  if (!attacker || !defender) return false;
  return strong.get(attacker) === defender;
}

/** The rings themselves, for tests and for anything that wants to show them. */
export const ELEMENTAL_RINGS = RINGS;
