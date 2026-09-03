import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { actOnParty, startParty } from "../src/engine/party/index.js";
import { partyForWire } from "../src/net/partySync.js";
import { PARTY, TICK } from "../src/data/balance.js";
import type { MatchPlayer, BotDifficulty } from "../src/match/types.js";

// The barrier games: everyone commits in secret, then one resolve.
//
// ⚠️ THE SECRET AND THE DEFAULT ARE THE TWO THINGS WORTH TESTING. If a pick can
// be seen before the barrier, the game is "wait and answer them" and nothing
// else; if not choosing is free, the game is "look away".

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

function table(count = 3, rng: () => number = () => 0.5, bots: BotDifficulty | null = null): Match {
  const kingdoms = ["fire", "water", "earth", "air", "ice", "nature", "dark"];
  const match = new Match("1234", { rng });
  for (let i = 0; i < count; i++) {
    match.addPlayer(player(`p${i}`, kingdoms[i]!, bots ?? undefined));
  }
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  for (const p of match.gameState!.getPlayers()) {
    earn(p, 5_000);
    p.castle.shield = 0;
  }
  return match;
}

const runTicks = (match: Match, count: number) => {
  for (let i = 0; i < count; i++) tickMatch(match, match.tick + 1);
};

/** Ticks until the session settles, and returns the picks as they stood then. */
function runUntilResolved(match: Match): (string | null)[] {
  for (let tick = 0; tick < 30 * TICK.RATE; tick++) {
    tickMatch(match, match.tick + 1);
    const session = match.gameState!.party;
    if (!session) return [];
    if (session.resolvedTick === null) continue;
    return Object.values(session.players).map((p) => (p.data.choice as string | null) ?? null);
  }
  return [];
}

// --- kingdom thief -----------------------------------------------------------

test("a choice is not on the wire until the whole table has made one", () => {
  // ⚠️ THE GAME IS THE SECRET. One player able to see the picks arrive would
  // simply wait and answer them — and once one player does that, everyone does.
  const match = table();
  startParty(match, "kingdomThief");
  const players = match.gameState!.getPlayers();

  actOnParty(match, players[0]!, { type: "choose", choice: "steal" });
  const midGame = partyForWire(match, match.gameState!.party!);
  assert.equal(midGame.players.p0!.data.choice, null, "a pick leaked before the barrier");
  // What IS visible is that they have decided — pressure, but not information.
  assert.equal(midGame.players.p0!.done, true);

  for (const p of players.slice(1)) actOnParty(match, p, { type: "choose", choice: "steal" });
  runTicks(match, 1);
  const settled = partyForWire(match, match.gameState!.party!);
  assert.equal(settled.players.p0!.data.choice, "steal", "picks never became visible");
});

test("everyone keeping pays everyone", () => {
  const match = table();
  startParty(match, "kingdomThief");
  const players = match.gameState!.getPlayers();
  const before = players.map((p) => p.economy.currency);

  for (const p of players) actOnParty(match, p, { type: "choose", choice: "keep" });
  runTicks(match, 1);

  for (const [i, p] of players.entries()) {
    assert.ok(p.economy.currency - before[i]! >= PARTY.THIEF_KEEP_REWARD, `p${i} was not paid`);
  }
  assert.ok(match.gameState!.party!.resultText?.includes("receive"));
});

test("everyone stealing hurts everyone", () => {
  const match = table();
  startParty(match, "kingdomThief");
  const players = match.gameState!.getPlayers();
  const before = players.map((p) => p.castle.hp);

  for (const p of players) actOnParty(match, p, { type: "choose", choice: "steal" });
  runTicks(match, 1);

  for (const [i, p] of players.entries()) {
    assert.equal(before[i]! - p.castle.hp, PARTY.THIEF_ALL_STEAL_DAMAGE, `p${i} escaped`);
  }
  assert.ok(match.gameState!.party!.resultText?.includes("take"));
});

test("a mixed table pays the thieves and nobody else", () => {
  const match = table();
  startParty(match, "kingdomThief");
  const players = match.gameState!.getPlayers();
  const before = players.map((p) => p.economy.currency);

  actOnParty(match, players[0]!, { type: "choose", choice: "steal" });
  actOnParty(match, players[1]!, { type: "choose", choice: "keep" });
  actOnParty(match, players[2]!, { type: "choose", choice: "keep" });
  runTicks(match, 1);

  assert.ok(players[0]!.economy.currency - before[0]! >= PARTY.THIEF_STEAL_REWARD);
  assert.ok(players[1]!.economy.currency - before[1]! < PARTY.THIEF_STEAL_REWARD / 2);
  assert.equal(players[1]!.castle.hp, players[1]!.castle.maxHp, "the honest were hurt");
  assert.ok(match.gameState!.party!.resultText?.includes("stole"));
});

test("not choosing is keeping, and it is decided after ten seconds", () => {
  // ⚠️ THE DEFAULT MATTERS AS MUCH AS THE RULES. Defaulting to STEAL would make
  // a distracted player the reason everybody took damage; defaulting to KEEP
  // costs them the thief's payout and nothing more.
  const match = table();
  startParty(match, "kingdomThief");
  const players = match.gameState!.getPlayers();
  actOnParty(match, players[0]!, { type: "choose", choice: "keep" });
  actOnParty(match, players[1]!, { type: "choose", choice: "keep" });

  runTicks(match, PARTY.CHOICE_SECONDS * TICK.RATE + 2);
  const session = match.gameState!.party!;
  assert.equal(session.players.p2!.data.choice, "keep");
  assert.equal(session.players.p2!.data.defaulted, true);
  // All three "kept", so the whole table is paid.
  assert.ok(session.resultText?.includes("receive"));
});

test("bots decide as a table, not one at a time", () => {
  // A third of the time they all keep, a third they all steal, a third they
  // each decide. Rolling every bot independently would make an all-steal table
  // essentially impossible on a big board — and that is the story this game is
  // for.
  let allKeep = 0;
  let allSteal = 0;
  let mixed = 0;
  for (let run = 0; run < 60; run++) {
    let seed = 13 + run * 7;
    const rng = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const match = table(4, rng, "hard");
    startParty(match, "kingdomThief");

    // ⚠️ READ AT THE BARRIER, NOT AFTER IT. A resolved session lingers for its
    // result banner and is then CLEARED, so ticking past the end and reading
    // `gameState.party` finds null every time — and a tally of nothing looks
    // exactly like a policy that never ran.
    const picks = runUntilResolved(match);
    if (picks.length === 0) continue;
    if (picks.every((c) => c === "keep")) allKeep += 1;
    else if (picks.every((c) => c === "steal")) allSteal += 1;
    else mixed += 1;
  }
  assert.ok(allKeep > 5, `all-keep happened ${allKeep} times in 60`);
  assert.ok(allSteal > 5, `all-steal happened ${allSteal} times in 60`);
  assert.ok(mixed > 5, `mixed happened ${mixed} times in 60`);
});

// --- pick a chest ------------------------------------------------------------

test("each kingdom gets its own shuffle, and it never travels", () => {
  // ⚠️ A SHARED ARRANGEMENT WOULD BE SOLVED BY THE FIRST PLAYER TO OPEN ONE.
  const match = table();
  startParty(match, "pickAChest");
  const wire = partyForWire(match, match.gameState!.party!);
  for (const state of Object.values(wire.players)) {
    assert.equal(state.data.chests, undefined, "the arrangement went out on the wire");
    assert.equal(state.data.prize, null, "a prize was visible before opening");
  }
});

test("opening pays, or bills — and a bill bigger than the purse becomes debt", () => {
  const match = table();
  startParty(match, "pickAChest");
  const session = match.gameState!.party!;
  const me = match.gameState!.getPlayer("p0")!;
  me.economy.currency = 100; // far less than the trap costs

  // Open whichever chest holds the trap for this player.
  const chests = session.players.p0!.data.chests as string[];
  const trapIndex = chests.indexOf("trap");
  actOnParty(match, me, { type: "open", index: trapIndex });

  assert.equal(me.economy.currency, 0, "the purse went negative");
  assert.equal(me.economy.productionDebt, PARTY.CHEST_TRAP - 100);
  assert.equal(session.players.p0!.outcome, "lost");
});

test("the big chest pays the most, the small one pays something", () => {
  const match = table();
  startParty(match, "pickAChest");
  const session = match.gameState!.party!;
  const players = match.gameState!.getPlayers();

  for (const [index, prize] of [
    ["big", PARTY.CHEST_BIG],
    ["small", PARTY.CHEST_SMALL],
  ].entries()) {
    const me = players[index]!;
    const chests = session.players[me.id]!.data.chests as string[];
    const before = me.economy.currency;
    actOnParty(match, me, { type: "open", index: chests.indexOf(prize[0] as string) });
    assert.ok(
      me.economy.currency - before >= (prize[1] as number),
      `${prize[0] as string} paid ${me.economy.currency - before}`,
    );
  }
});

test("a chest is opened for anybody who never picked one", () => {
  const match = table();
  startParty(match, "pickAChest");
  runTicks(match, PARTY.CHOICE_SECONDS * TICK.RATE + 2);
  const session = match.gameState!.party!;
  for (const state of Object.values(session.players)) {
    assert.notEqual(state.data.picked, null, "a kingdom was left holding nothing");
    assert.equal(state.data.defaulted, true);
    assert.notEqual(state.outcome, null);
  }
});

test("every shuffle holds exactly one of each", () => {
  let seed = 3;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 100; i++) {
    const match = table(2, rng);
    startParty(match, "pickAChest");
    for (const state of Object.values(match.gameState!.party!.players)) {
      const chests = [...(state.data.chests as string[])].sort();
      assert.deepEqual(chests, ["big", "small", "trap"], `run ${i}`);
    }
  }
});
