import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { activateAbility, getUpgradeLevel } from "../src/engine/abilities.js";
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
  swapGrantsUnlock,
  buildShower,
  buildMess,
} from "../src/engine/party/index.js";
import { abilityPrices } from "../src/net/gameSync.js";
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

// --- kingdom swap -------------------------------------------------------------
//
// ⚠️ RETIRED, SO ITS TESTS ARE GONE WITH IT. Kingdom Swap is no longer in
// PARTY_GAMES: `startParty` refuses the id, so every test here would have been
// asserting against a session that never starts — and a test that passes because
// nothing happened is worse than no test. The module and its slot-mirroring
// plumbing are still in the engine, inert, for whenever the mode comes back;
// the tests come back with it.

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

test("the mess covers the whole screen, with no gap to see through", () => {
  // ⚠️ COVERAGE IS THE GAME NOW. Seven scattered blobs left most of the screen
  // clean, so cleaning was tapping seven targets. Every tile has to be filled
  // at the start and every part of the screen has to be inside one, or there
  // are pinholes — and a screen of pinholes reads as a rendering fault.
  let seed = 7;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const columns = 6;
  const rows = 10;
  const mess = buildMess(rng, columns, rows);
  assert.equal(mess.length, columns * rows, "the grid has holes in it");
  assert.equal(new Set(mess.map((s) => s.id)).size, mess.length, "two tiles share an id");

  for (const splat of mess) {
    assert.ok(splat.x > 0 && splat.x < 1, `x ${splat.x}`);
    assert.ok(splat.y > 0 && splat.y < 1, `y ${splat.y}`);
    assert.ok(splat.r > 0 && splat.r < 0.2, `r ${splat.r}`);
  }

  // Sampled across the screen: every point is inside some tile. The test is in
  // the same stretched space the client draws in — `r` is a fraction of the
  // WIDTH and the vertical radius is 0.78 of that against the HEIGHT.
  for (let gx = 0; gx <= 20; gx++) {
    for (let gy = 0; gy <= 20; gy++) {
      const px = gx / 20;
      const py = gy / 20;
      const covered = mess.some((s) => {
        const dx = (px - s.x) / s.r;
        const dy = (py - s.y) / (s.r * 0.78);
        return dx * dx + dy * dy <= 1;
      });
      assert.ok(covered, `nothing covers ${px.toFixed(2)}, ${py.toFixed(2)}`);
    }
  }
});
