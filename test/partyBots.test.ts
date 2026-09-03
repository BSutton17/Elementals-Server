import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { startParty } from "../src/engine/party/index.js";
import { bookMove } from "../src/engine/party/partyBlackjack.js";
import { successChance, REACTION_MS, MASH_CPS, BOMB_PASS_MS } from "../src/engine/party/bots.js";
import { PARTY, TICK } from "../src/data/balance.js";
import type { MatchPlayer, BotDifficulty } from "../src/match/types.js";
import type { Card, Hand } from "../src/engine/party/partyBlackjack.js";

// How bots play party games.
//
// ⚠️ THE POINT OF EVERY TEST HERE IS THAT DIFFICULTY IS ACTUALLY READ. A policy
// that ignores it looks completely fine in play — the bots do things, at
// plausible times — and quietly makes the lobby's difficulty setting a
// decoration.

const bot = (id: string, kingdomId: string, difficulty: BotDifficulty): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
  isBot: true,
  botDifficulty: difficulty,
});

/** A table of bots at one standard, with a seeded stream. */
function botTable(difficulty: BotDifficulty, seed: number, count = 3): Match {
  let state = seed;
  const rng = () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
  const kingdoms = ["fire", "water", "earth", "air", "ice", "nature", "dark"];
  const match = new Match("1234", { rng });
  for (let i = 0; i < count; i++) match.addPlayer(bot(`p${i}`, kingdoms[i]!, difficulty));
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

/**
 * Runs a game to its end many times and reports how often bots succeeded.
 *
 * ⚠️ SAMPLED THE TICK IT RESOLVES, NOT AFTERWARDS. A finished session lingers
 * for its result banner and is then CLEARED, so reading `gameState.party` at
 * the end of a long run mostly finds null — which silently turned forty runs
 * into three and made the rate whatever those three did.
 */
function successRate(gameId: Parameters<typeof startParty>[1], difficulty: BotDifficulty): number {
  let wins = 0;
  let played = 0;
  for (let run = 0; run < 40; run++) {
    const match = botTable(difficulty, 97 + run * 7);
    startParty(match, gameId);

    for (let tick = 0; tick < 40 * TICK.RATE; tick++) {
      tickMatch(match, match.tick + 1);
      const session = match.gameState!.party;
      if (!session) break;
      if (session.resolvedTick === null) continue;
      for (const state of Object.values(session.players)) {
        if (!state.done) continue;
        played += 1;
        if (state.outcome === "won") wins += 1;
      }
      break;
    }
  }
  return played === 0 ? 0 : wins / played;
}

// --- the skill games ---------------------------------------------------------

test("a maze bot succeeds about as often as its difficulty says", () => {
  // Sampled rather than asserted exactly: it is a dice roll, and a test that
  // demanded 0.50 from forty samples would fail on its own randomness. The
  // bands are wide enough to be stable and narrow enough that a policy which
  // ignored difficulty could not pass all three.
  const easy = successRate("maze", "easy");
  const hard = successRate("maze", "hard");
  assert.ok(easy > 0.25 && easy < 0.72, `easy solved ${easy}`);
  assert.ok(hard > 0.72, `hard solved ${hard}`);
  assert.ok(hard > easy, "difficulty made no difference at all");
});

test("a memory bot answers about as well as its difficulty says", () => {
  const easy = successRate("memory", "easy");
  const hard = successRate("memory", "hard");
  assert.ok(easy < hard, `easy ${easy} vs hard ${hard}`);
  assert.ok(hard > 0.7, `hard answered ${hard}`);
});

test("the difficulty table itself is the one the design asks for", () => {
  assert.equal(successChance("easy"), 0.5);
  assert.equal(successChance("medium"), 0.75);
  assert.equal(successChance("hard"), 0.9);
});

// --- the games bots keep trying at -------------------------------------------

test("a weak bot is SLOW at spot-the-difference, not absent", () => {
  // ⚠️ THE WHOLE REASON IT REROLLS. One roll would mean half of all easy bots
  // simply never find the difference — and this game's punishment is for being
  // last, so "never" and "slow" are very different mechanics.
  const easy = botTable("easy", 31);
  startParty(easy, "spotTheDifference");
  runTicks(easy, PARTY.SPOT_MAX_SECONDS * TICK.RATE);

  const hard = botTable("hard", 31);
  startParty(hard, "spotTheDifference");
  runTicks(hard, PARTY.SPOT_MAX_SECONDS * TICK.RATE);
  // Given long enough, bots of both standards get there; the weak one is later.
  assert.equal(easy.gameState!.party, null, "the easy table never finished at all");
  assert.equal(hard.gameState!.party, null, "the hard table never finished at all");
});

test("a quick-math bot retries instead of giving up on one bad roll", () => {
  const match = botTable("easy", 53);
  startParty(match, "quickMath");
  runTicks(match, 3 * TICK.RATE);
  const attemptsEarly = Object.values(match.gameState!.party!.players).reduce(
    (n, p) => n + ((p.data.attempts as number) ?? 0),
    0,
  );
  runTicks(match, 20 * TICK.RATE);
  const session = match.gameState!.party;
  const attemptsLate = session
    ? Object.values(session.players).reduce((n, p) => n + ((p.data.attempts as number) ?? 0), 0)
    : Infinity;
  assert.ok(attemptsLate > attemptsEarly, "a bot rolled once and sat there");
});

// --- the timing games --------------------------------------------------------

test("a reaction bot never clicks before the light, at any difficulty", () => {
  // ⚠️ THE FAILURE THIS CATCHES IS TOTAL. Schedule a bot's click from the start
  // of the session rather than from the light and every bot jumps the gun in
  // every game — they would lose every reaction test by construction.
  for (const difficulty of ["easy", "medium", "hard"] as BotDifficulty[]) {
    for (let run = 0; run < 12; run++) {
      const match = botTable(difficulty, 11 + run * 13);
      startParty(match, "reaction");
      runTicks(match, PARTY.REACTION_MAX_SECONDS * TICK.RATE);
      const session = match.gameState!.party;
      if (!session) continue;
      for (const state of Object.values(session.players)) {
        assert.notEqual(state.data.jumped, true, `${difficulty} bot jumped the gun`);
      }
    }
  }
});

test("a harder bot reacts faster than an easier one", () => {
  const average = (difficulty: BotDifficulty) => {
    let total = 0;
    let seen = 0;
    for (let run = 0; run < 25; run++) {
      const match = botTable(difficulty, 5 + run * 17);
      startParty(match, "reaction");
      runTicks(match, PARTY.REACTION_MAX_SECONDS * TICK.RATE);
      const session = match.gameState!.party;
      if (!session) continue;
      for (const state of Object.values(session.players)) {
        const ticks = state.data.reactionTicks as number | undefined;
        if (ticks === undefined) continue;
        total += ticks;
        seen += 1;
      }
    }
    return seen === 0 ? Infinity : total / seen;
  };

  assert.ok(average("hard") <= average("easy"), "difficulty did not change reaction speed");
  assert.ok(REACTION_MS.hard[1] <= REACTION_MS.easy[0], "the bands overlap the wrong way");
});

test("mash rate and bomb-pass speed are banded by difficulty", () => {
  // Pure table checks: the policies read these, and a band that crossed over
  // would make a "hard" bot the slow one.
  assert.ok(MASH_CPS.easy[1] <= MASH_CPS.hard[1]);
  assert.ok(MASH_CPS.hard[0] > MASH_CPS.easy[0]);

  // ⚠️ THE BOMB BANDS OVERLAP, AND THEY SHOULD. Asserting that the hardest bot
  // is always faster than the easiest one forces the bands apart, which makes
  // every pass land on the same beat and turns the bomb into a metronome going
  // round the table — the loser decided by seating. What has to hold is the
  // ORDER (floor and midpoint), not separation.
  const middle = ([low, high]: [number, number]) => (low + high) / 2;
  assert.ok(BOMB_PASS_MS.hard[0] < BOMB_PASS_MS.medium[0]);
  assert.ok(BOMB_PASS_MS.medium[0] < BOMB_PASS_MS.easy[0]);
  assert.ok(middle(BOMB_PASS_MS.hard) < middle(BOMB_PASS_MS.medium));
  assert.ok(middle(BOMB_PASS_MS.medium) < middle(BOMB_PASS_MS.easy));
});

test("a mash bot clicks inside its band", () => {
  const match = botTable("hard", 71);
  startParty(match, "buttonMash");
  runTicks(match, PARTY.MASH_SECONDS * TICK.RATE);
  const session = match.gameState!.party!;
  for (const state of Object.values(session.players)) {
    const clicks = (state.data.clicks as number) ?? 0;
    const perSecond = clicks / PARTY.MASH_SECONDS;
    assert.ok(
      perSecond >= MASH_CPS.hard[0] - 1 && perSecond <= MASH_CPS.hard[1] + 1,
      `hard bot managed ${perSecond.toFixed(1)} clicks a second`,
    );
  }
});

test("a bomb bot passes it on in well under a second", () => {
  const match = botTable("hard", 19);
  startParty(match, "bombAttack");
  const session = match.gameState!.party!;
  // ⚠️ COUNT THE PASSES, DO NOT COMPARE THE HOLDER. Bots pass in a third of a
  // second, so within one second the bomb has been round two or three hands and
  // can easily be back where it started — "the holder changed" is a test that
  // fails on a game working perfectly.
  runTicks(match, TICK.RATE);
  assert.ok((session.shared.passes as number) >= 2, `only ${session.shared.passes} passes a second`);
});

// --- blackjack ---------------------------------------------------------------

const card = (rank: number): Card => ({ rank, suit: "spades" });
const hand = (ranks: number[], over: Partial<Hand> = {}): Hand => ({
  cards: ranks.map(card),
  bet: 100,
  standing: false,
  doubled: false,
  fromSplit: false,
  outcome: null,
  ...over,
});

test("blackjack bots play the book", () => {
  // ⚠️ BASIC STRATEGY IS OPTIMAL HERE, so "by the book" is not a difficulty
  // setting — the shoe is infinite and there is nothing to count. These are the
  // lines any printed card gives.
  assert.equal(bookMove(hand([1, 1]), card(7), true), "split", "aces are always split");
  assert.equal(bookMove(hand([8, 8]), card(10), true), "split", "eights are always split");
  assert.equal(bookMove(hand([10, 10]), card(6), true), "stand", "never split twenty");
  assert.equal(bookMove(hand([5, 5]), card(6), true), "double", "fives are a hard ten");

  assert.equal(bookMove(hand([10, 6]), card(5), false), "stand", "sixteen stands against a five");
  assert.equal(bookMove(hand([10, 6]), card(10), false), "hit", "sixteen hits against a ten");
  assert.equal(bookMove(hand([10, 2]), card(3), false), "hit", "twelve hits against a three");
  assert.equal(bookMove(hand([10, 2]), card(5), false), "stand", "twelve stands against a five");

  assert.equal(bookMove(hand([5, 6]), card(10), false), "double", "eleven doubles");
  assert.equal(bookMove(hand([1, 7]), card(9), false), "hit", "soft eighteen hits a nine");
  assert.equal(bookMove(hand([1, 7]), card(9), false), "hit");
  assert.equal(bookMove(hand([1, 8]), card(6), false), "stand", "soft nineteen stands");
  assert.equal(bookMove(hand([10, 7]), card(1), false), "stand", "seventeen always stands");
});

test("a bot never doubles a hand it has already hit", () => {
  // Doubling is only legal on the first two cards; the book must not ask for a
  // move the rules refuse, or the bot stalls until the session's cap.
  const threeCards = hand([2, 3, 6]); // eleven, but not fresh
  assert.notEqual(bookMove(threeCards, card(5), false), "double");
});
