import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { activateAbility } from "../src/engine/abilities.js";
import { abilitiesForKingdom } from "../src/data/kingdomAbilities.js";
import { selectTarget } from "../src/engine/targeting.js";
import {
  actOnParty,
  generateMaze,
  routeIsLegal,
  startParty,
  partySuppressesAttacks,
  buildSequence,
  buildQuestion,
  angleInZone,
  nextLock,
  handValue,
  openHand,
  resolveRound,
  settleMoney,
  eligibleCastles,
} from "../src/engine/party/index.js";
import { PARTY, TICK } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { MazeLayout } from "../src/engine/party/maze.js";

// Party Mode: the clock, the session, and the five solo games.

const matchPlayer = (id: string, kingdomId: string, isBot = false): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
  isBot,
});

function table(
  kingdoms: readonly string[] = ["fire", "water", "earth"],
  rng: () => number = () => 0,
  bots: readonly string[] = [],
): Match {
  const match = new Match("1234", { rng });
  kingdoms.forEach((k, i) => match.addPlayer(matchPlayer(`p${i}`, k, bots.includes(`p${i}`))));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  for (const p of match.gameState!.getPlayers()) earn(p, 5_000);
  return match;
}

const runTicks = (match: Match, count: number) => {
  for (let i = 0; i < count; i++) tickMatch(match, match.tick + 1);
};

// --- the clock ---------------------------------------------------------------

test("a public room never throws a party", () => {
  // ⚠️ SAME RULE AS MONSTERS. A stranger queued for a free-for-all did not
  // agree to be dropped into a maze, so matchmaking rooms are opted out at
  // construction rather than being asked to opt out later.
  const match = new Match("1234", { rng: () => 0, visibility: "public" });
  assert.equal(match.partyModeEnabled, false);
  ["fire", "water"].forEach((k, i) => match.addPlayer(matchPlayer(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));

  runTicks(match, PARTY.FIRST_ROLL_SECONDS * TICK.RATE * 3);
  assert.equal(match.gameState!.party, null);
});

test("the roll waits for the middle of the field to clear", async () => {
  // Frozen, not skipped: a table that spent its twenty-five seconds watching a
  // volcano has not used up its turn at a minigame.
  const match = table(["magma", "water", "earth"], () => 0);
  const magma = match.gameState!.getPlayer("p0")!;
  const ultimate = abilitiesForKingdom("magma").find((a) => a.kind === "ultimate")!;
  earn(magma, 100_000);
  // Unlock it, then put the volcano up.
  const { unlockOrUpgradeAbility } = await import("../src/engine/purchases.js");
  for (let i = 0; i < 5; i++) unlockOrUpgradeAbility(match, magma, ultimate.id);
  assert.equal(activateAbility(match, magma, ultimate).ok, true);

  runTicks(match, PARTY.FIRST_ROLL_SECONDS * TICK.RATE + 5);
  assert.equal(match.gameState!.party, null, "a party started under a volcano");
});

// --- the session -------------------------------------------------------------

test("a minigame holds attacks until the first kingdom finishes", () => {
  // ⚠️ THE POINT OF THE WHOLE GATE. A table looking at a maze cannot defend
  // itself; being shot at for playing along would teach everybody to ignore
  // Party Mode.
  const match = table(["fire", "water", "earth"], () => 0);
  startParty(match, "maze");
  assert.equal(partySuppressesAttacks(match), true);

  const fire = match.gameState!.getPlayer("p0")!;
  const basic = abilitiesForKingdom("fire").find((a) => a.kind === "attack")!;
  selectTarget(match, fire, "p1");
  const blocked = activateAbility(match, fire, basic, { targetId: "p1" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "PARTY_IN_PROGRESS");

  // The maze is solved by somebody, and the war resumes — even though the rest
  // of the table is still in it.
  const maze = match.gameState!.party!.shared.maze as unknown as MazeLayout;
  const solved = actOnParty(match, match.gameState!.getPlayer("p1")!, {
    type: "solve",
    route: solveMaze(maze),
  });
  assert.equal(solved.ok, true);
  assert.equal(partySuppressesAttacks(match), false);
  assert.equal(activateAbility(match, fire, basic, { targetId: "p1" }).ok, true);
});

test("a blocking minigame stops production for whoever has not finished", () => {
  const match = table(["fire", "water"], () => 0);
  startParty(match, "memory");
  const [a, b] = match.gameState!.getPlayers();
  const beforeA = a!.economy.currency;
  const beforeB = b!.economy.currency;

  runTicks(match, TICK.RATE * 2);
  assert.equal(a!.economy.currency, beforeA, "earned while still answering");

  const question = match.gameState!.party!.shared.question as { answer: string };
  actOnParty(match, a!, { type: "answer", symbol: question.answer });
  runTicks(match, TICK.RATE * 2);
  assert.ok(a!.economy.currency > beforeA, "still frozen after answering");
  assert.equal(b!.economy.currency, beforeB, "the one still thinking earned anyway");
});

test("the result banner lingers, then the session clears", () => {
  const match = table(["fire", "water"], () => 0);
  startParty(match, "spotTheDifference");
  const session = match.gameState!.party!;
  const spot = session.shared.spot as unknown as {
    ornaments: { x: number; y: number }[];
    changedIndex: number;
  };
  const target = spot.ornaments[spot.changedIndex]!;
  for (const player of match.gameState!.getPlayers()) {
    actOnParty(match, player, { type: "tap", x: target.x, y: target.y });
  }
  runTicks(match, 1);
  assert.equal(match.gameState!.party!.resolvedTick !== null, true);
  assert.ok(match.gameState!.party!.resultText?.includes("last one to spot"));

  runTicks(match, PARTY.RESULT_SECONDS * TICK.RATE + 2);
  assert.equal(match.gameState!.party, null, "the session outstayed its banner");
});

// --- the maze ----------------------------------------------------------------

/** Walks the carve with a breadth-first search — the reference solver. */
function solveMaze(maze: MazeLayout): { row: number; col: number }[] {
  const key = (r: number, c: number) => r * maze.size + c;
  const previous = new Map<number, number>();
  const queue = [key(maze.start.row, maze.start.col)];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const at = queue.shift()!;
    const row = Math.floor(at / maze.size);
    const col = at % maze.size;
    if (row === maze.exit.row && col === maze.exit.col) break;
    const cell = maze.cells[at]!;
    const steps: [boolean, number, number][] = [
      [cell.top, row - 1, col],
      [cell.bottom, row + 1, col],
      [cell.left, row, col - 1],
      [cell.right, row, col + 1],
    ];
    for (const [walled, r, c] of steps) {
      if (walled || r < 0 || c < 0 || r >= maze.size || c >= maze.size) continue;
      const next = key(r, c);
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, at);
      queue.push(next);
    }
  }

  const route: { row: number; col: number }[] = [];
  let cursor = key(maze.exit.row, maze.exit.col);
  while (cursor !== key(maze.start.row, maze.start.col)) {
    route.unshift({ row: Math.floor(cursor / maze.size), col: cursor % maze.size });
    const back = previous.get(cursor);
    assert.notEqual(back, undefined, "the maze has no route to its exit");
    cursor = back!;
  }
  route.unshift({ row: maze.start.row, col: maze.start.col });
  return route;
}

test("every generated maze can be solved, a hundred times over", () => {
  // ⚠️ SOLVABLE BY CONSTRUCTION, NOT BY LUCK. A carve reaches every cell, so
  // there is no "generate and retry" loop to get wrong — and this is the test
  // that would catch it if the carve ever stopped being one.
  let seed = 1;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 100; i++) {
    const maze = generateMaze(10, rng);
    const route = solveMaze(maze);
    assert.ok(routeIsLegal(maze, route), `maze ${i} could not be walked`);
  }
});

test("a route that walks through walls is refused", () => {
  // The client reports the path it dragged, never the verdict. A straight line
  // to the exit is the first thing anybody would try.
  const match = table(["fire", "water"], () => 0.5);
  startParty(match, "maze");
  const maze = match.gameState!.party!.shared.maze as unknown as MazeLayout;
  const cheat = [
    { row: maze.start.row, col: maze.start.col },
    { row: maze.exit.row, col: maze.exit.col },
  ];
  const result = actOnParty(match, match.gameState!.getPlayer("p0")!, {
    type: "solve",
    route: cheat,
  });
  assert.equal(result.ok, false);
  assert.equal(match.gameState!.party!.players.p0!.done, false);
});

// --- memory ------------------------------------------------------------------

test("the sequence is eight symbols with exactly one repeat, never adjacent", () => {
  // The repeat is load-bearing: "which symbol appeared twice?" has no answer
  // without one, and two answers with two of them.
  let seed = 7;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 60; i++) {
    const sequence = buildSequence(rng);
    assert.equal(sequence.length, 8);
    const counts = new Map<string, number>();
    for (const symbol of sequence) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    const doubles = [...counts.values()].filter((n) => n === 2);
    assert.equal(doubles.length, 1, `run ${i} had ${doubles.length} repeats`);
    assert.ok([...counts.values()].every((n) => n <= 2));
    for (let j = 1; j < sequence.length; j++) {
      assert.notEqual(sequence[j], sequence[j - 1], `run ${i} flashed a symbol twice in a row`);
    }
  }
});

test("every question has exactly one right answer", () => {
  let seed = 13;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 60; i++) {
    const sequence = buildSequence(rng);
    const question = buildQuestion(sequence, rng);
    if (question.kind === "positional") {
      assert.equal(question.answer, sequence[question.position! - 1]);
    } else if (question.kind === "repeated") {
      assert.equal(sequence.filter((s) => s === question.answer).length, 2);
    } else {
      // The anchor must be unique, or "what came before it" has two answers.
      const anchors = sequence.filter((s) => s === question.after).length;
      assert.equal(anchors, 1, `run ${i}: ambiguous anchor`);
      const index = sequence.indexOf(question.after!);
      assert.equal(question.answer, sequence[index - 1]);
    }
  }
});

test("memory pays for a right answer and bites for a wrong one", () => {
  const match = table(["fire", "water"], () => 0);
  startParty(match, "memory");
  const question = match.gameState!.party!.shared.question as { answer: string };
  const [a, b] = match.gameState!.getPlayers();

  const beforeGold = a!.economy.currency;
  actOnParty(match, a!, { type: "answer", symbol: question.answer });
  assert.equal(a!.economy.currency - beforeGold, PARTY.MEMORY_REWARD);

  const wrongSymbol = question.answer === "abacus" ? "android" : "abacus";
  const beforeHp = b!.castle.hp;
  actOnParty(match, b!, { type: "answer", symbol: wrongSymbol });
  assert.equal(beforeHp - b!.castle.hp, PARTY.MEMORY_PENALTY);
});

// --- lockpick ----------------------------------------------------------------

test("a lock is only picked inside its zone, wrap included", () => {
  const lock = { ...nextLock(0, () => 0.5), zoneStart: 350, zoneWidth: 30 };
  assert.equal(angleInZone(355, lock), true, "inside, before the wrap");
  assert.equal(angleInZone(10, lock), true, "inside, after the wrap");
  assert.equal(angleInZone(200, lock), false);
  // Negative and over-360 angles are the same places on the dial.
  assert.equal(angleInZone(-5, lock), true);
  assert.equal(angleInZone(370, lock), true);
});

test("a miss resets the current lock and never the run", () => {
  const match = table(["fire", "water"], () => 0.5);
  startParty(match, "lockpick");
  const me = match.gameState!.party!.players.p0!;
  const lock = () => me.data.lock as { picked: number; zoneStart: number; misses: number };

  // Pick two, then fumble the third.
  for (let i = 0; i < 2; i++) {
    actOnParty(match, match.gameState!.getPlayer("p0")!, {
      type: "strike",
      angle: lock().zoneStart + 2,
    });
  }
  assert.equal(lock().picked, 2);

  actOnParty(match, match.gameState!.getPlayer("p0")!, {
    type: "strike",
    angle: lock().zoneStart + 180,
  });
  assert.equal(lock().picked, 2, "a miss cost the whole run");
  assert.equal(lock().misses, 1);
});

test("the last kingdom to pick all five is paid nothing", () => {
  // Everyone can finish this one, so a reward for finishing is a fee for
  // showing up. The table is racing each other.
  const match = table(["fire", "water"], () => 0.5);
  startParty(match, "lockpick");
  const players = match.gameState!.getPlayers();
  const before = players.map((p) => p.economy.currency);

  for (const player of players) {
    for (let i = 0; i < PARTY.LOCK_TARGET; i++) {
      const lock = match.gameState!.party!.players[player.id]!.data.lock as {
        zoneStart: number;
      };
      actOnParty(match, player, { type: "strike", angle: lock.zoneStart + 2 });
    }
  }
  runTicks(match, 1);

  // Bracketed rather than exact: production restarts the moment a player is
  // done, so a tick or two of ordinary income lands in the same window.
  const paid = players[0]!.economy.currency - before[0]!;
  const unpaid = players[1]!.economy.currency - before[1]!;
  assert.ok(paid >= PARTY.LOCK_REWARD, `first place got ${paid}`);
  assert.ok(unpaid < PARTY.LOCK_REWARD / 2, `last place was paid ${unpaid}`);
});

// --- blackjack ---------------------------------------------------------------

test("aces count eleven until that would bust", () => {
  assert.deepEqual(handValue([{ rank: 1, suit: "clubs" }]), { total: 11, soft: true });
  assert.equal(
    handValue([
      { rank: 1, suit: "clubs" },
      { rank: 1, suit: "hearts" },
    ]).total,
    12,
  );
  assert.equal(
    handValue([
      { rank: 1, suit: "clubs" },
      { rank: 13, suit: "hearts" },
    ]).total,
    21,
  );
  assert.equal(
    handValue([
      { rank: 1, suit: "clubs" },
      { rank: 9, suit: "hearts" },
      { rank: 9, suit: "spades" },
    ]).total,
    19,
  );
});

test("a loss bigger than the purse becomes production debt, never a negative balance", () => {
  // ⚠️ THE WHOLE POINT OF THE DEBT RULE. Doubling past what you hold is the fun;
  // a currency below zero would break every price check in the game.
  const match = table(["fire", "water"], () => 0.5);
  const player = match.gameState!.getPlayer("p0")!;
  player.economy.currency = 1_000;

  const state = openHand(player, () => 0.5);
  state.hands[0]!.bet = 4_000; // as if doubled and split into a hole
  state.hands[0]!.cards = [
    { rank: 10, suit: "clubs" },
    { rank: 10, suit: "hearts" },
    { rank: 10, suit: "spades" },
  ]; // a bust
  resolveRound(state, () => 0.5);
  settleMoney(player, state);

  assert.equal(player.economy.currency, 0, "the purse went negative");
  assert.equal(player.economy.productionDebt, 3_000);

  // And the debt is worked off out of income rather than sitting there.
  const before = player.economy.productionDebt!;
  runTicks(match, TICK.RATE * 3);
  assert.ok(player.economy.productionDebt! < before, "the debt never came down");
  assert.equal(player.economy.currency, 0, "earned while still in debt");
});

test("the dealer's hole card is not on the wire until it is turned", async () => {
  const { partyForWire } = await import("../src/net/partySync.js");
  const match = table(["fire", "water"], () => 0.5);
  startParty(match, "blackjack");

  const before = partyForWire(match, match.gameState!.party!);
  const hidden = (before.players.p0!.data.game as { dealerHole: unknown }).dealerHole;
  assert.equal(hidden, null, "the hole card leaked");

  // Stand out; once the dealer turns it over, it is public.
  actOnParty(match, match.gameState!.getPlayer("p0")!, { type: "stand" });
  const after = partyForWire(match, match.gameState!.party!);
  const shown = (after.players.p0!.data.game as { dealerHole: unknown }).dealerHole;
  assert.notEqual(shown, null, "the hole card never appeared");
});

// --- spot the difference -----------------------------------------------------

test("only rare and legendary castles that hold still are used", () => {
  // A difference you have to catch between two frames of an animation is a
  // reflex test, not a spot-the-difference.
  const castles = eligibleCastles();
  assert.ok(castles.length >= 8, `only ${castles.length} castles to choose from`);
  assert.ok(castles.every((c) => c.id.startsWith("castle.")));
});

test("a tap near the changed ornament wins, one away from it does not", () => {
  const match = table(["fire", "water"], () => 0.3);
  startParty(match, "blackjack"); // wrong game on purpose
  match.gameState!.party = null;
  startParty(match, "spotTheDifference");

  const spot = match.gameState!.party!.shared.spot as unknown as {
    ornaments: { x: number; y: number }[];
    changedIndex: number;
  };
  const target = spot.ornaments[spot.changedIndex]!;
  const player = match.gameState!.getPlayer("p0")!;

  actOnParty(match, player, { type: "tap", x: target.x + 200, y: target.y + 200 });
  assert.equal(match.gameState!.party!.players.p0!.done, false);
  assert.equal(match.gameState!.party!.players.p0!.data.misses, 1);

  actOnParty(match, player, { type: "tap", x: target.x + 4, y: target.y - 4 });
  assert.equal(match.gameState!.party!.players.p0!.done, true);
});

// --- bots --------------------------------------------------------------------

test("bots play, so a table of them still finishes", () => {
  // ⚠️ WITHOUT THIS, PARTY MODE IS A BOT CULL. Most tables have bots in them; a
  // bot that cannot play a minigame either stalls the session to its cap or
  // loses every one of them.
  const match = table(["fire", "water", "earth"], Math.random, ["p1", "p2"]);
  startParty(match, "lockpick");
  runTicks(match, 25 * TICK.RATE);

  // The human at p0 never plays, so the session is still open — but both bots
  // must have picked their way through it on their own.
  const session = match.gameState!.party!;
  assert.equal(session.players.p1!.done, true, "a bot sat on its hands");
  assert.equal(session.players.p2!.done, true, "a bot sat on its hands");
  assert.equal(session.players.p0!.done, false, "the human finished by itself");

  // And the cap closes it even though that human never answered, so one idle
  // seat cannot hold the next roll hostage forever.
  runTicks(match, PARTY.LOCKPICK_MAX_SECONDS * TICK.RATE);
  assert.equal(match.gameState!.party, null, "an abandoned session never closed");
});

test("nothing claims the middle of the field until the dust settles", async () => {
  // ⚠️ ATTACKS COME BACK IMMEDIATELY, CENTREPIECES DO NOT, AND THE GAP IS THE
  // POINT. The moment one kingdom escapes the maze the table can defend itself
  // again — but a volcano or a monster arriving on that same beat greets
  // everyone still in the maze with an ultimate they never saw cast.
  const { PARTY } = await import("../src/data/balance.js");
  const { unlockOrUpgradeAbility } = await import("../src/engine/purchases.js");
  const { partyBlocksCentrepieces } = await import("../src/engine/party/index.js");

  const match = table(["magma", "water", "earth"], () => 0);
  const magma = match.gameState!.getPlayer("p0")!;
  const ultimate = abilitiesForKingdom("magma").find((a) => a.kind === "ultimate")!;
  earn(magma, 100_000);
  for (let i = 0; i < 5; i++) unlockOrUpgradeAbility(match, magma, ultimate.id);

  startParty(match, "maze");
  assert.equal(partyBlocksCentrepieces(match), true, "open season during the game");
  assert.equal(activateAbility(match, magma, ultimate).ok, false);

  // Somebody escapes: the fight resumes, the volcano still may not.
  const maze = match.gameState!.party!.shared.maze as unknown as MazeLayout;
  actOnParty(match, match.gameState!.getPlayer("p1")!, {
    type: "solve",
    route: solveMaze(maze),
  });
  assert.equal(partySuppressesAttacks(match), false, "attacks stayed held");
  assert.equal(partyBlocksCentrepieces(match), true, "the volcano came straight back");
  assert.equal(activateAbility(match, magma, ultimate).ok, false);

  // ...and after the grace it is allowed again.
  runTicks(match, Math.round(PARTY.CENTREPIECE_GRACE_SECONDS * TICK.RATE) + 2);
  assert.equal(partyBlocksCentrepieces(match), false);
});

test("a monster will not spawn into the gap either", async () => {
  const { partyBlocksCentrepieces } = await import("../src/engine/party/index.js");
  const match = table(["fire", "water", "earth"], () => 0);
  match.monstersEnabled = true;

  startParty(match, "spotTheDifference");
  // Long enough that the spawn clock would certainly have rolled by now.
  runTicks(match, 200);
  assert.equal(partyBlocksCentrepieces(match), true);
  assert.equal(match.gameState!.monster, null, "a monster landed mid-minigame");
});
