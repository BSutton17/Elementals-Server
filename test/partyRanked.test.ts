import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { selectTarget } from "../src/engine/targeting.js";
import { actOnParty, startParty, longestHolder } from "../src/engine/party/index.js";
import { partyForWire } from "../src/net/partySync.js";
import { PARTY, TICK } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";

// Party Mode, batch two: the games that rank the whole table.
//
// ⚠️ EVERY ONE OF THESE HANDS OUT DAMAGE BASED ON ORDER, which makes the order
// the thing worth testing hardest — who finished, who never did, and what
// happens to the player the table beat.

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

function table(kingdoms: readonly string[] = ["fire", "water", "earth"], rng = () => 0.5): Match {
  const match = new Match("1234", { rng });
  kingdoms.forEach((k, i) => match.addPlayer(matchPlayer(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  for (const p of match.gameState!.getPlayers()) {
    earn(p, 5_000);
    // ⚠️ SHIELDS OFF. Earth starts behind one, and a shield absorbs a party
    // penalty exactly as it absorbs anything else — which makes an assertion
    // on castle HP silently pass whatever the game did. These tests are about
    // WHO gets hit, so the padding comes off.
    p.castle.shield = 0;
  }
  return match;
}

const runTicks = (match: Match, count: number) => {
  for (let i = 0; i < count; i++) tickMatch(match, match.tick + 1);
};

// --- reaction ----------------------------------------------------------------

test("clicking before the light costs you, and clicking after does not", () => {
  const match = table();
  startParty(match, "reaction");
  const session = match.gameState!.party!;
  const greenAt = session.shared.greenAtTick as number;
  const [a, b] = match.gameState!.getPlayers();

  const beforeA = a!.castle.hp;
  actOnParty(match, a!, { type: "click" });
  assert.equal(beforeA - a!.castle.hp, PARTY.REACTION_PENALTY, "jumping the gun was free");
  assert.equal(session.players.p0!.outcome, "lost");

  runTicks(match, greenAt - match.tick + 1);
  const beforeB = b!.castle.hp;
  actOnParty(match, b!, { type: "click" });
  assert.equal(b!.castle.hp, beforeB, "a good click was punished");
  assert.equal(session.players.p1!.outcome, "won");
});

test("the tick the light turns green is never on the wire", () => {
  // ⚠️ SEND THE DEADLINE AND THE GAME IS A SCRIPT. Five lines of console and
  // every reaction test is won by whoever wrote them.
  const match = table();
  startParty(match, "reaction");
  const before = partyForWire(match, match.gameState!.party!);
  assert.equal(before.shared.greenAtTick, undefined);
  assert.equal(before.shared.green, false);

  runTicks(match, PARTY.REACTION_MAX_DELAY_SECONDS * TICK.RATE + 2);
  const after = partyForWire(match, match.gameState!.party!);
  assert.equal(after.shared.green, true);
});

test("the last kingdom to react takes it, and a jumper is not hit twice", () => {
  const match = table();
  startParty(match, "reaction");
  const session = match.gameState!.party!;
  const players = match.gameState!.getPlayers();

  actOnParty(match, players[0]!, { type: "click" });
  const afterJump = players[0]!.castle.hp;

  runTicks(match, (session.shared.greenAtTick as number) - match.tick + 1);
  actOnParty(match, players[1]!, { type: "click" });
  runTicks(match, 8);
  const beforeLast = players[2]!.castle.hp;
  actOnParty(match, players[2]!, { type: "click" });
  runTicks(match, 2);

  assert.equal(players[0]!.castle.hp, afterJump, "the jumper paid twice");
  assert.equal(beforeLast - players[2]!.castle.hp, PARTY.REACTION_PENALTY, "last place walked");
  assert.ok(match.gameState!.party!.resultText?.includes("last one to react"));
});

// --- quick math --------------------------------------------------------------

test("a wrong answer is refused, not fatal", () => {
  // Ending someone's turn on a typo would punish the fat-fingered rather than
  // the slow, which is not the game.
  const match = table();
  startParty(match, "quickMath");
  const session = match.gameState!.party!;
  const answer = session.shared.answer as number;
  const me = match.gameState!.getPlayer("p0")!;

  const wrong = actOnParty(match, me, { type: "answer", value: answer + 1 });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, "Try again");
  assert.equal(session.players.p0!.done, false);
  assert.equal(session.players.p0!.data.attempts, 1);

  const right = actOnParty(match, me, { type: "answer", value: answer });
  assert.equal(right.ok, true);
  assert.equal(session.players.p0!.done, true);
});

test("the sum is shown but its answer is not", () => {
  const match = table();
  startParty(match, "quickMath");
  const wire = partyForWire(match, match.gameState!.party!);
  assert.equal(typeof wire.shared.left, "number");
  assert.equal(typeof wire.shared.right, "number");
  assert.equal(wire.shared.answer, undefined, "the answer went out with the question");
});

test("subtraction never asks for a negative answer", () => {
  let seed = 5;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 200; i++) {
    const match = table(["fire", "water"], rng);
    startParty(match, "quickMath");
    const shared = match.gameState!.party!.shared;
    assert.ok((shared.answer as number) >= 0, `run ${i} asked for a negative`);
    if (shared.op === "-") assert.ok((shared.left as number) >= (shared.right as number));
  }
});

test("whoever answers last takes the hit", () => {
  const match = table();
  startParty(match, "quickMath");
  const answer = match.gameState!.party!.shared.answer as number;
  const players = match.gameState!.getPlayers();

  actOnParty(match, players[0]!, { type: "answer", value: answer });
  runTicks(match, 4);
  actOnParty(match, players[1]!, { type: "answer", value: answer });
  runTicks(match, 4);
  const before = players[2]!.castle.hp;
  actOnParty(match, players[2]!, { type: "answer", value: answer });
  runTicks(match, 2);

  assert.equal(before - players[2]!.castle.hp, PARTY.QUICK_MATH_PENALTY);
  assert.ok(match.gameState!.party!.resultText?.includes("last one to answer correctly"));
});

test("never answering is worse than answering last", () => {
  // ⚠️ NOT FINISHING HAS TO RANK BELOW FINISHING. Otherwise the way to win a
  // "last one to X" game is to refuse to play it.
  const match = table();
  startParty(match, "quickMath");
  const answer = match.gameState!.party!.shared.answer as number;
  const players = match.gameState!.getPlayers();

  actOnParty(match, players[0]!, { type: "answer", value: answer });
  runTicks(match, 4);
  actOnParty(match, players[1]!, { type: "answer", value: answer });
  const before = players[2]!.castle.hp;

  runTicks(match, PARTY.QUICK_MATH_MAX_SECONDS * TICK.RATE + 2);
  assert.equal(before - players[2]!.castle.hp, PARTY.QUICK_MATH_PENALTY, "the quitter got away");
});

// --- button mash -------------------------------------------------------------

test("a client cannot claim more clicks than a human could make", () => {
  // ⚠️ THE COUNT IS A NUMBER THE CLIENT CHOSE. Clicks are batched over the wire
  // for bandwidth, so the only thing standing between this game and a one-line
  // cheat is the rate cap.
  const match = table();
  startParty(match, "buttonMash");
  const me = match.gameState!.getPlayer("p0")!;

  runTicks(match, TICK.RATE);
  actOnParty(match, me, { type: "mash", clicks: 100_000 });
  const credited = match.gameState!.party!.players.p0!.data.clicks as number;
  assert.ok(credited <= PARTY.MASH_MAX_PER_SECOND + 1, `credited ${credited}`);
});

test("most clicks heals, fewest takes it", () => {
  const match = table();
  startParty(match, "buttonMash");
  const players = match.gameState!.getPlayers();
  players[0]!.castle.hp = players[0]!.castle.maxHp - 4000;

  // ⚠️ SNAPSHOT BEFORE THE CLOCK RUNS OUT, not after. This game resolves
  // itself on its own tick, so a "before" taken at the end of the loop is
  // already an "after" and the assertion passes on a game that did nothing.
  const beforeWinner = players[0]!.castle.hp;
  const beforeLoser = players[2]!.castle.hp;

  for (let second = 0; second < PARTY.MASH_SECONDS - 1; second++) {
    runTicks(match, TICK.RATE);
    actOnParty(match, players[0]!, { type: "mash", clicks: 12 });
    actOnParty(match, players[1]!, { type: "mash", clicks: 6 });
    actOnParty(match, players[2]!, { type: "mash", clicks: 1 });
  }
  runTicks(match, TICK.RATE + 2);

  assert.ok(players[0]!.castle.hp > beforeWinner, "the winner was not healed");
  assert.equal(beforeLoser - players[2]!.castle.hp, PARTY.MASH_PENALTY);
  const result = match.gameState!.party!.resultText ?? "";
  assert.ok(result.includes("clicked the most") && result.includes("clicked the least"));
});

// --- bomb attack -------------------------------------------------------------

test("the bomb is charged once a tick, to whoever is holding it", () => {
  // ⚠️ ONCE PER TICK, NOT ONCE PER SEAT. Billing held time from the per-player
  // hook charges the holder once for every kingdom at the table, so a duel and
  // a seven-player game would count seconds at different speeds.
  const match = table();
  startParty(match, "bombAttack");
  const session = match.gameState!.party!;
  const holder = session.shared.holderId as string;

  runTicks(match, 20);
  const held = session.players[holder]!.data.heldTicks as number;
  assert.ok(Math.abs(held - 20) <= 1, `charged ${held} ticks for 20`);
});

test("passing moves the clock to the kingdom you passed it to", () => {
  const match = table();
  startParty(match, "bombAttack");
  const session = match.gameState!.party!;
  const holderId = session.shared.holderId as string;
  const other = Object.keys(session.players).find((id) => id !== holderId)!;

  runTicks(match, 10);
  const passed = actOnParty(match, match.gameState!.getPlayer(holderId)!, {
    type: "pass",
    targetId: other,
  });
  assert.equal(passed.ok, true);
  assert.equal(session.shared.holderId, other);

  runTicks(match, 10);
  assert.ok((session.players[other]!.data.heldTicks as number) >= 9);

  const notYours = actOnParty(match, match.gameState!.getPlayer(holderId)!, {
    type: "pass",
    targetId: other,
  });
  assert.equal(notYours.ok, false);
});

test("aiming is off while a bomb is live", () => {
  // Clicking a castle passes the bomb; a click that also re-aimed an attack
  // would be unusable.
  const match = table();
  startParty(match, "bombAttack");
  const me = match.gameState!.getPlayer("p0")!;
  assert.equal(selectTarget(match, me, "p1").ok, false);
});

test("the kingdom that held it longest explodes", () => {
  const match = table();
  startParty(match, "bombAttack");
  const session = match.gameState!.party!;
  const holderId = session.shared.holderId as string;

  runTicks(match, PARTY.BOMB_SECONDS * TICK.RATE + 2);
  const loser = match.gameState!.getPlayer(holderId)!;
  assert.ok(loser.castle.maxHp - loser.castle.hp >= PARTY.BOMB_DAMAGE);
  assert.ok(match.gameState!.party!.resultText?.includes("has exploded"));
});

test("longestHolder ignores a seat that is no longer in the match", () => {
  const match = table();
  startParty(match, "bombAttack");
  const session = match.gameState!.party!;
  session.players.ghost = {
    done: false,
    outcome: null,
    finishedTick: null,
    data: { heldTicks: 9999 },
  };
  assert.notEqual(longestHolder(match, session), "ghost");
});
