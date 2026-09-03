import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { activateAbility } from "../src/engine/abilities.js";
import { selectTarget } from "../src/engine/targeting.js";
import { applyDamage } from "../src/engine/combat.js";
import { resolveWinner } from "../src/engine/winConditions.js";
import { abilitiesForKingdom } from "../src/data/kingdomAbilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import {
  actOnParty,
  startParty,
  isGhost,
  hasGhostsToRaise,
  kitKingdomOf,
  mirrorSlot,
  buildShower,
  buildMess,
} from "../src/engine/party/index.js";
import { PARTY, TICK } from "../src/data/balance.js";
import type { MatchPlayer, BotDifficulty } from "../src/match/types.js";

// Party Mode, batch four: the ambient games.
//
// ⚠️ THESE TOUCH THE ENGINE'S OWN RULES MORE THAN THE OTHER TEN COMBINED —
// elimination, targeting, damage, income, the win condition and which abilities
// a kingdom even has. Most of what is worth testing here is what must NOT
// change.

const player = (id: string, kingdomId: string, bot?: BotDifficulty): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
  isBot: bot !== undefined,
  botDifficulty: bot,
});

function table(
  kingdoms: readonly string[] = ["fire", "water", "earth"],
  rng: () => number = () => 0.5,
  bots: BotDifficulty | null = null,
): Match {
  const match = new Match("1234", { rng });
  kingdoms.forEach((k, i) => match.addPlayer(player(`p${i}`, k, bots ?? undefined)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  for (const p of match.gameState!.getPlayers()) {
    earn(p, 20_000);
    p.castle.shield = 0;
  }
  return match;
}

const runTicks = (match: Match, count: number) => {
  for (let i = 0; i < count; i++) tickMatch(match, match.tick + 1);
};

// --- don't move --------------------------------------------------------------

test("moving costs, and sitting still costs nothing", () => {
  const match = table();
  startParty(match, "dontMove");
  const [a, b] = match.gameState!.getPlayers();
  const beforeA = a!.castle.hp;
  const beforeB = b!.castle.hp;

  actOnParty(match, a!, { type: "moved" });
  assert.equal(beforeA - a!.castle.hp, PARTY.DONT_MOVE_PENALTY);
  assert.equal(match.gameState!.party!.players.p0!.outcome, "lost");

  // ...and a second report does not bill them twice.
  actOnParty(match, a!, { type: "moved" });
  assert.equal(beforeA - a!.castle.hp, PARTY.DONT_MOVE_PENALTY);

  runTicks(match, PARTY.DONT_MOVE_SECONDS * TICK.RATE + 2);
  assert.equal(b!.castle.hp, beforeB, "sitting still was punished");
});

test("gold keeps coming in while nobody moves", () => {
  // ⚠️ THE ONE THING THAT MAKES IT BEARABLE. Six seconds of doing nothing is
  // already the cost; stopping production on top would make the safe play
  // actively expensive.
  const match = table();
  startParty(match, "dontMove");
  const me = match.gameState!.getPlayer("p0")!;
  const before = me.economy.currency;
  runTicks(match, 3 * TICK.RATE);
  assert.ok(me.economy.currency > before, "production stopped");
});

// --- haunted -----------------------------------------------------------------

test("a ghost is still eliminated, and cannot win the match", () => {
  // ⚠️ THE TRAP THIS WHOLE DESIGN AVOIDS. `resolveWinner` ends a match when at
  // most one player is not eliminated. Clearing `eliminated` to raise a ghost
  // would stop a finished match ending AND could hand victory to a kingdom that
  // died minutes ago.
  const match = table();
  const [a, b, c] = match.gameState!.getPlayers();
  b!.eliminated = true;
  c!.eliminated = true;

  startParty(match, "haunted");
  assert.equal(isGhost(match, b!.id), true, "nobody was raised");
  assert.equal(b!.eliminated, true, "a ghost stopped being eliminated");

  const outcome = resolveWinner(match.gameState!);
  assert.equal(outcome.ended, true, "the match refused to end with ghosts up");
  assert.equal(outcome.winnerId, a!.id, "the win went to the wrong kingdom");
});

test("a ghost can act, and cannot be touched", () => {
  const match = table();
  const [alive, dead] = match.gameState!.getPlayers();
  dead!.eliminated = true;
  startParty(match, "haunted");

  // It can aim and cast.
  assert.equal(selectTarget(match, dead!, alive!.id).ok, true, "a ghost could not aim");
  const basic = abilitiesForKingdom(dead!.kingdomId).find((a) => a.kind === "attack")!;
  unlockOrUpgradeAbility(match, dead!, basic.id);
  assert.equal(
    activateAbility(match, dead!, basic, { targetId: alive!.id }).ok,
    true,
    "a ghost could not cast",
  );

  // ...and nothing can touch it back, because it is still eliminated.
  const before = dead!.castle.hp;
  applyDamage(dead!, 5000, { tick: match.tick });
  assert.equal(dead!.castle.hp, before, "a ghost took damage");
  assert.equal(selectTarget(match, alive!, dead!.id).ok, false, "a ghost was targetable");
});

test("the dead go back when their time is up", () => {
  const match = table();
  const dead = match.gameState!.getPlayer("p1")!;
  dead.eliminated = true;
  startParty(match, "haunted");
  assert.equal(dead.economy.citizens, PARTY.GHOST_CITIZENS);

  runTicks(match, PARTY.HAUNTED_SECONDS * TICK.RATE + 2);
  assert.equal(isGhost(match, dead.id), false, "the ghost never left");
  assert.equal(dead.economy.citizens, 0, "it kept its borrowed citizens");

  const basic = abilitiesForKingdom(dead.kingdomId).find((a) => a.kind === "attack")!;
  assert.equal(activateAbility(match, dead, basic, { targetId: "p0" }).ok, false);
});

test("Haunted is never rolled when there is nobody to raise", () => {
  // A banner announcing nothing, that would still hold the next roll for its
  // whole duration.
  const match = table();
  assert.equal(hasGhostsToRaise(match), false);
  assert.equal(startParty(match, "haunted"), null, "it started with no dead");
});

// --- kingdom swap ------------------------------------------------------------

test("a swap changes the kit and nothing else", () => {
  const match = table(["fire", "water", "earth"], () => 0.2);
  const players = match.gameState!.getPlayers();
  const before = players.map((p) => ({
    kingdomId: p.kingdomId,
    hp: p.castle.hp,
    gold: p.economy.currency,
    citizens: p.economy.citizens,
  }));

  startParty(match, "kingdomSwap");

  for (const [i, p] of players.entries()) {
    // ⚠️ THE IDENTITY IS UNTOUCHED. `kingdomId` drives the castle's colour, the
    // roster, the scoreboard and the win screen; only the ability layer sees
    // the borrowed kingdom.
    assert.equal(p.kingdomId, before[i]!.kingdomId, "the kingdom itself changed");
    assert.equal(p.castle.hp, before[i]!.hp);
    assert.equal(p.economy.currency, before[i]!.gold);
    assert.equal(p.economy.citizens, before[i]!.citizens);
    assert.notEqual(kitKingdomOf(p), p.kingdomId, "nobody actually swapped");
  }
});

test("a borrowed ability is unlocked by the slot you already paid for", () => {
  // ⚠️ WITHOUT SLOT MIRRORING A BORROWED KIT IS A LOCKED KIT: unlocks are per
  // ability id, and nobody owns anything in somebody else's list.
  const match = table(["fire", "water"], () => 0.2);
  const me = match.gameState!.getPlayer("p0")!;
  const mine = abilitiesForKingdom(me.kingdomId);
  unlockOrUpgradeAbility(match, me, mine[1]!.id); // buy my own slot two

  startParty(match, "kingdomSwap");
  const borrowedKingdom = kitKingdomOf(me);
  assert.notEqual(borrowedKingdom, me.kingdomId);

  const borrowed = abilitiesForKingdom(borrowedKingdom);
  selectTarget(match, me, "p1");
  assert.equal(
    activateAbility(match, me, borrowed[1]!, { targetId: "p1" }).ok,
    true,
    "the mirrored slot would not cast",
  );

  // ⚠️ THE UNLOCK GATE ITSELF LIVES IN THE CAST HANDLER, NOT IN THE ENGINE, so
  // it is checked where it actually is: what the handler reads is the MIRRORED
  // id, and that is the whole mechanism.
  for (const [slot, ability] of borrowed.entries()) {
    assert.equal(mirrorSlot(me, ability.id), mine[slot]!.id, `slot ${slot} mirrored wrong`);
  }
  assert.equal(me.unlocked[mirrorSlot(me, borrowed[1]!.id)], true, "the bought slot read locked");
  assert.notEqual(
    me.unlocked[mirrorSlot(me, borrowed[4]!.id)],
    true,
    "a slot nobody bought read unlocked",
  );
});

test("your own kit is out while you hold somebody else's", () => {
  const match = table(["fire", "water"], () => 0.2);
  const me = match.gameState!.getPlayer("p0")!;
  const mine = abilitiesForKingdom(me.kingdomId);
  unlockOrUpgradeAbility(match, me, mine[0]!.id);

  startParty(match, "kingdomSwap");
  selectTarget(match, me, "p1");
  const own = activateAbility(match, me, mine[0]!, { targetId: "p1" });
  assert.equal(own.ok, false, "they cast from both kits at once");
  assert.equal(own.error, "NOT_ACTIVATABLE");
});

test("the kit comes back when the swap ends", () => {
  const match = table(["fire", "water"], () => 0.2);
  const me = match.gameState!.getPlayer("p0")!;
  startParty(match, "kingdomSwap");
  assert.notEqual(kitKingdomOf(me), me.kingdomId);

  runTicks(match, PARTY.SWAP_SECONDS * TICK.RATE + 2);
  assert.equal(kitKingdomOf(me), me.kingdomId, "they kept the borrowed kit");
});

// --- gold party --------------------------------------------------------------

test("a coin pays once, to one kingdom, and never before it falls", () => {
  // ⚠️ THE ONLY THING BETWEEN THIS GAME AND FREE GOLD. Coins are dealt by the
  // server with ids; a catch is a claim against one id.
  const match = table();
  startParty(match, "goldParty");
  const session = match.gameState!.party!;
  const coins = session.shared.coins as { id: number; atTick: number }[];
  const me = match.gameState!.getPlayer("p0")!;

  const late = coins.find((c) => c.atTick > 40)!;
  assert.equal(actOnParty(match, me, { type: "catch", coinId: late.id }).ok, false);

  const first = coins[0]!;
  const before = me.economy.currency;
  assert.equal(actOnParty(match, me, { type: "catch", coinId: first.id }).ok, true);
  const after = me.economy.currency;
  assert.ok(after > before, "the coin paid nothing");

  // Twice is nothing.
  assert.equal(actOnParty(match, me, { type: "catch", coinId: first.id }).ok, false);
  assert.equal(me.economy.currency, after);
  // And a coin that does not exist is nothing.
  assert.equal(actOnParty(match, me, { type: "catch", coinId: 9999 }).ok, false);
});

test("gold is rarer than silver, and silver rarer than bronze", () => {
  let seed = 11;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const tally = { bronze: 0, silver: 0, gold: 0 };
  for (let i = 0; i < 200; i++) {
    for (const coin of buildShower(rng, PARTY.GOLD_PARTY_SECONDS)) tally[coin.kind] += 1;
  }
  assert.ok(tally.bronze > tally.silver, `bronze ${tally.bronze} vs silver ${tally.silver}`);
  assert.ok(tally.silver > tally.gold, `silver ${tally.silver} vs gold ${tally.gold}`);
});

test("every coin falls somewhere catchable", () => {
  let seed = 29;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (const coin of buildShower(rng, PARTY.GOLD_PARTY_SECONDS)) {
    // Half off-screen is a coin nobody can catch.
    assert.ok(coin.x >= 0.05 && coin.x <= 0.95, `coin at ${coin.x}`);
  }
});

// --- clean up ----------------------------------------------------------------

test("the mess costs nothing but visibility", () => {
  const match = table();
  startParty(match, "cleanUp");
  const me = match.gameState!.getPlayer("p0")!;
  const hp = me.castle.hp;
  const gold = me.economy.currency;

  runTicks(match, 3 * TICK.RATE);
  assert.equal(me.castle.hp, hp, "cleaning cost health");
  assert.ok(me.economy.currency > gold, "production stopped for a spill");
});

test("wiping every splat ends it early, and ignoring it ends it anyway", () => {
  const match = table();
  startParty(match, "cleanUp");
  const session = match.gameState!.party!;
  const me = match.gameState!.getPlayer("p0")!;
  const splats = session.players.p0!.data.splats as { id: number }[];

  for (const splat of splats) actOnParty(match, me, { type: "wipe", splatId: splat.id });
  assert.equal(session.players.p0!.done, true, "a spotless screen was not finished");
  assert.equal(session.players.p0!.outcome, "won");

  // p1 never lifts a finger and is still fine when it washes off.
  runTicks(match, PARTY.CLEAN_UP_SECONDS * TICK.RATE + 2);
  const stillThere = match.gameState!.getPlayer("p1")!;
  assert.equal(stillThere.castle.hp, stillThere.castle.maxHp, "ignoring the mess hurt");
});

test("each kingdom gets its own mess", () => {
  // A shared one would have everybody's screen dirty in the same places, and
  // cleaning would look synchronised.
  //
  // ⚠️ A VARYING RNG, NOT THE HARNESS DEFAULT. The default stream returns 0.5
  // forever, which is ideal for pinning an exact value and useless for asking
  // "are these two different" — every mess comes out identical and the test
  // fails on its own fixture.
  let seed = 17;
  const match = table(["fire", "water", "earth"], () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  });
  startParty(match, "cleanUp");
  const session = match.gameState!.party!;
  const first = JSON.stringify(session.players.p0!.data.splats);
  const second = JSON.stringify(session.players.p1!.data.splats);
  assert.notEqual(first, second);
});

test("a mess is always somewhere on the screen", () => {
  let seed = 7;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (const splat of buildMess(rng, 200)) {
    assert.ok(splat.x > 0 && splat.x < 1, `x ${splat.x}`);
    assert.ok(splat.y > 0 && splat.y < 1, `y ${splat.y}`);
    assert.ok(splat.r > 0 && splat.r < 0.2, `r ${splat.r}`);
  }
});
