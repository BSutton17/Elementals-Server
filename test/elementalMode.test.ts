import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { resolveDamage } from "../src/engine/damage.js";
import {
  ELEMENTAL_RINGS,
  hasAdvantage,
  strongAgainst,
  weakAgainst,
} from "../src/data/elementalCycle.js";
import { KINGDOM_IDS, KINGDOM_PASSIVES } from "../src/data/kingdoms.js";
import { ELEMENTAL } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";

/**
 * "Elemental's Elementaled": matchups modify damage.
 *
 * ⚠️ THE RULE IS ONE RELATIONSHIP WITH TWO EFFECTS, NOT TWO RULES. Being strong
 * against a kingdom means both hitting it harder and shrugging off what it
 * throws back — so in any exchange exactly one of the two multipliers applies to
 * each direction, and never both to the same hit.
 */

const seat = (id: string, kingdomId: string): MatchPlayer =>
  ({
    id,
    socketId: `s-${id}`,
    name: id,
    kingdomId,
    perks: [],
    ready: true,
    connected: true,
  }) as never as MatchPlayer;

function arena(a: string, b: string, on: boolean) {
  const match = new Match("ELEM", { rng: () => 0.99 }); // never crits
  match.addPlayer(seat("p0", a));
  match.addPlayer(seat("p1", b));
  match.hostId = "p0";
  match.elementalEnabled = on;
  match.start(createMatchConfig(match));
  const players = match.gameState!;
  return { match, attacker: players.getPlayer("p0")!, defender: players.getPlayer("p1")! };
}

/** One clean hit, with crits and elements out of the picture. */
const hit = (a: string, b: string, on: boolean) => {
  const { attacker, defender } = arena(a, b, on);
  return resolveDamage(attacker, defender, 1000, { forceCrit: false, rng: () => 0.99 })
    .amount;
};

// --- the rings ---------------------------------------------------------------

test("every kingdom sits in exactly one ring", () => {
  // ⚠️ THE PROPERTY THE WHOLE RULE RESTS ON. A kingdom in no ring plays the mode
  // with no matchup at all; one in two rings has two answers to "who am I
  // strong against". Neither throws, and neither is visible from a match.
  const placed = ELEMENTAL_RINGS.flat();
  assert.equal(new Set(placed).size, placed.length, "a kingdom is in two rings");
  assert.equal(placed.length, KINGDOM_IDS.length, "the rings do not cover every kingdom");
  for (const kingdom of KINGDOM_IDS) {
    assert.ok(placed.includes(kingdom), `${kingdom} is in no ring`);
  }
});

test("strong and weak are the same relationship read from both ends", () => {
  for (const kingdom of KINGDOM_IDS) {
    const beats = strongAgainst(kingdom)!;
    assert.ok(beats, `${kingdom} is strong against nothing`);
    assert.equal(weakAgainst(beats), kingdom, `${beats} does not fear ${kingdom}`);
    assert.equal(hasAdvantage(kingdom, beats), true);
    assert.equal(hasAdvantage(beats, kingdom), false, "an advantage ran both ways");
  }
});

test("the rings match the ones that were asked for", () => {
  const chain: [string, string][] = [
    ["water", "fire"],
    ["fire", "ice"],
    ["ice", "nature"],
    ["nature", "earth"],
    ["earth", "air"],
    ["air", "electricity"],
    ["electricity", "water"],
    ["time", "space"],
    ["space", "light"],
    ["light", "dark"],
    ["dark", "love"],
    ["love", "time"],
    ["joker", "kitsune"],
    ["kitsune", "magma"],
    ["magma", "insects"],
    ["insects", "joker"],
  ];
  for (const [a, b] of chain) {
    assert.equal(strongAgainst(a), b, `${a} should beat ${b}`);
  }
});

// --- the damage --------------------------------------------------------------

test("a match that never heard of the rule is unaffected by it", () => {
  // ⚠️ THE FIELD IS OPTIONAL, SO ABSENT MUST MEAN OFF. `MatchConfig` is
  // hand-built in tests and by callers older than this rule, and a missing flag
  // reading as ON would quietly apply matchups to every one of them.
  const bare = new Match("OLD", { rng: () => 0.99 });
  bare.addPlayer(seat("p0", "water"));
  bare.addPlayer(seat("p1", "fire"));
  bare.hostId = "p0";
  const config = createMatchConfig(bare);
  delete (config as { elementalEnabled?: boolean }).elementalEnabled;
  bare.start(config);

  const a = bare.gameState!.getPlayer("p0")!;
  const b = bare.gameState!.getPlayer("p1")!;
  assert.equal(a.elementalEnabled, false, "an absent flag was read as enabled");
  assert.equal(
    resolveDamage(a, b, 1000, { rng: () => 0.99 }).amount,
    hit("water", "fire", false),
    "a config without the field behaved differently from one with it off",
  );
});

/**
 * ⚠️ THE SAME PAIR, RULE ON VERSUS OFF — NEVER TWO DIFFERENT PAIRS. Kingdoms
 * are not interchangeable baselines: Fire carries a +35% damage passive and
 * Earth starts behind a 2,000 shield, so "Water into Fire" against "Water into
 * Earth" compares two matchups AND two sets of passives at once. Holding the
 * pair fixed and flipping only the rule isolates exactly the thing under test.
 */
const edge = (a: string, b: string) => hit(a, b, true) / hit(a, b, false);

test("the favoured kingdom deals ten per cent more", () => {
  // Water beats Fire.
  assert.equal(
    edge("water", "fire").toFixed(3),
    (1 + ELEMENTAL.EDGE_PCT).toFixed(3),
    "the advantage was not worth its ten per cent",
  );
});

test("...and takes ten per cent less from the kingdom it is strong against", () => {
  // The same relationship from the other end: Fire hitting Water.
  assert.equal(
    edge("fire", "water").toFixed(3),
    (1 - ELEMENTAL.EDGE_PCT).toFixed(3),
    "being strong against somebody did not soften their hits",
  );
});

test("a matchup never applies twice to the same hit", () => {
  // Exactly ten per cent, not twenty-one. Water's hit into Fire is boosted and
  // NOT also reduced; a single relationship, read once per direction.
  const both = (1 + ELEMENTAL.EDGE_PCT) * (1 + ELEMENTAL.EDGE_PCT);
  assert.notEqual(edge("water", "fire").toFixed(3), both.toFixed(3));
  assert.equal(edge("water", "fire").toFixed(3), (1 + ELEMENTAL.EDGE_PCT).toFixed(3));
});

test("an unrelated pair fights as though the rule were off", () => {
  // Different rings entirely: Water and Time have nothing to do with each other.
  assert.equal(edge("water", "time").toFixed(3), (1).toFixed(3));
});

test("it stacks with a perk rather than replacing it", () => {
  // ⚠️ MULTIPLIED IN WITH EVERYTHING ELSE. "Sharper Swords" is a flat attacker
  // multiplier; the matchup has to compose with it, not overwrite it.
  const bare = arena("water", "fire", true);
  const perked = arena("water", "fire", true);
  perked.attacker.perks = ["sharperSwords"] as never;

  const a = resolveDamage(bare.attacker, bare.defender, 1000, { rng: () => 0.99 }).amount;
  const b = resolveDamage(perked.attacker, perked.defender, 1000, { rng: () => 0.99 }).amount;
  assert.ok(b > a, "the perk did nothing on top of the matchup");
});

// --- what the rule replaced --------------------------------------------------

test("Ice no longer burns for half again as long", () => {
  // Its "weak to fire" was a NEGATIVE status-duration reduction, which is the
  // same weakness this rule now expresses — and charging Ice for it twice, only
  // one of which a player can see, is worse than charging it once.
  const burn = (KINGDOM_PASSIVES.ice ?? []).find(
    (p) => p.type === "statusDurationReduction" && p.statusId === "burn",
  );
  assert.equal(burn, undefined, "Ice still carries its Burn vulnerability");
});

test("the room rule is off unless somebody asks for it", () => {
  const match = new Match("ELEM");
  assert.equal(match.elementalEnabled, false);
  assert.equal(match.serialize().elementalEnabled, false);
  const publicRoom = new Match("PUB", { visibility: "public" });
  assert.equal(publicRoom.elementalEnabled, false);
});
