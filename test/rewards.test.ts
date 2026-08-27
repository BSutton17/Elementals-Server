import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coinsFor,
  levelFromXp,
  masteryFor,
  opponentWeight,
  outlastScore,
  rewardsFor,
  xpForNextLevel,
  xpFor,
} from "../src/engine/rewards.js";
import { LEVELS, XP } from "../src/data/progression.js";
import type { MatchParticipantResult, MatchResult } from "../src/match/matchResult.js";

// The reward model, stated as rules:
//   1. you are paid for who you OUTLASTED
//   2. placing higher pays EXPONENTIALLY more
//   3. a bigger lobby therefore pays more, with no separate rule for it
//   4. a bot seat is worth a fraction of a human one
// Each test below pins one of those, so a retune can change the numbers but
// not the shape.

const seat = (
  id: string,
  placement: number,
  isBot = false,
  botDifficulty: string | null = null,
): MatchParticipantResult =>
  ({ playerId: id, placement, isBot, botDifficulty }) as MatchParticipantResult;

/** A lobby of `n` humans, placed 1..n. */
const humans = (n: number) => Array.from({ length: n }, (_, i) => seat("p" + i, i + 1));

// --- rule 1: outlasting ------------------------------------------------------

test("you are paid for the opponents you finished ahead of", () => {
  const all = humans(4);
  assert.equal(outlastScore(all[0]!, all), 3, "the winner outlasted everyone");
  assert.equal(outlastScore(all[3]!, all), 0, "last place outlasted nobody");
});

test("players who TIED count for neither of them", () => {
  // A draw's survivors, or two kingdoms eliminated on the same tick. Neither
  // outlasted the other, so neither is paid for the other.
  const all = [seat("a", 1), seat("b", 1), seat("c", 3)];
  assert.equal(outlastScore(all[0]!, all), 1, "only the kingdom that placed lower");
  assert.equal(outlastScore(all[1]!, all), 1);
  assert.equal(outlastScore(all[2]!, all), 0);
});

test("last place still earns something for turning up", () => {
  const all = humans(5);
  assert.equal(xpFor(all[4]!, all), XP.PARTICIPATION);
  assert.ok(xpFor(all[4]!, all) > 0, "finishing a match is never worth nothing");
});

// --- rule 2: exponential by placement ----------------------------------------

test("EACH STEP UP THE TABLE IS WORTH MORE THAN THE LAST", () => {
  // This is what separates "exponential" from "rises with placement". A linear
  // model satisfies the second and fails this.
  const all = humans(7);
  const xp = all.map((s) => xpFor(s, all)); // index 0 = 1st place
  const gaps: number[] = [];
  for (let i = xp.length - 1; i > 0; i--) gaps.push(xp[i - 1]! - xp[i]!);

  for (let i = 1; i < gaps.length; i++) {
    assert.ok(
      gaps[i]! > gaps[i - 1]!,
      `climbing to place ${xp.length - i} must be worth more than the step below (${gaps[i]} vs ${gaps[i - 1]})`,
    );
  }
});

test("placing higher always pays more", () => {
  const all = humans(7);
  for (let i = 1; i < all.length; i++) {
    assert.ok(xpFor(all[i - 1]!, all) > xpFor(all[i]!, all));
  }
});

// --- rule 3: lobby size falls out of outlasting ------------------------------

test("A FULL LOBBY PAYS FAR MORE THAN A DUEL, without a rule saying so", () => {
  const duelWin = xpFor(humans(2)[0]!, humans(2));
  const fullWin = xpFor(humans(7)[0]!, humans(7));
  assert.ok(
    fullWin > duelWin * 3,
    `a seven-player win (${fullWin}) should dwarf a 1v1 win (${duelWin})`,
  );
});

test("adding a player to the lobby raises what a win is worth", () => {
  let previous = 0;
  for (let n = 2; n <= 7; n++) {
    const win = xpFor(humans(n)[0]!, humans(n));
    assert.ok(win > previous, `${n} players should beat ${n - 1}`);
    previous = win;
  }
});

// --- rule 4: the bot penalty -------------------------------------------------

test("a bot seat is worth a fraction of a human one, by difficulty", () => {
  assert.equal(opponentWeight(seat("h", 2)), 1);
  assert.equal(opponentWeight(seat("b", 2, true, "easy")), 0.05);
  assert.equal(opponentWeight(seat("b", 2, true, "medium")), 0.1);
  assert.equal(opponentWeight(seat("b", 2, true, "hard")), 0.25);
});

test("an unknown bot difficulty is worth the LEAST, not the most", () => {
  // Fail cheap. A future difficulty nobody weighted must not become the
  // most profitable thing to farm.
  assert.equal(opponentWeight(seat("b", 2, true, null)), XP.BOT_WEIGHT_DEFAULT);
  assert.equal(opponentWeight(seat("b", 2, true, "nightmare")), XP.BOT_WEIGHT_DEFAULT);
});

test("A LOBBY PADDED WITH BOTS CANNOT PAY LIKE A FULL HOUSE", () => {
  // The farming case: fill six seats with bots and win instantly.
  const withHumans = humans(7);
  const withEasyBots = [
    seat("me", 1),
    ...Array.from({ length: 6 }, (_, i) => seat("b" + i, i + 2, true, "easy")),
  ];
  const real = xpFor(withHumans[0]!, withHumans);
  const farmed = xpFor(withEasyBots[0]!, withEasyBots);

  assert.ok(farmed < real * 0.25, `${farmed} must be far below ${real}`);
  // And harder bots are worth more than easy ones, so playing up is rewarded.
  const withHardBots = [
    seat("me", 1),
    ...Array.from({ length: 6 }, (_, i) => seat("b" + i, i + 2, true, "hard")),
  ];
  assert.ok(xpFor(withHardBots[0]!, withHardBots) > farmed);
});

test("bots themselves earn nothing", () => {
  const all = [seat("me", 2), seat("bot", 1, true, "hard")];
  assert.equal(xpFor(all[1]!, all), 0);
  assert.equal(coinsFor(all[1]!, all), 0);
});

test("only humans appear in the rewards for a match", () => {
  const result = {
    participants: [seat("me", 1), seat("bot", 2, true, "hard")],
  } as MatchResult;
  const rewards = rewardsFor(result);
  assert.equal(rewards.length, 1);
  assert.equal(rewards[0]!.playerId, "me");
});

// --- coins follow the same shape ---------------------------------------------

test("coins follow the same rules as XP, at a lower rate", () => {
  const all = humans(7);
  for (let i = 1; i < all.length; i++) {
    assert.ok(coinsFor(all[i - 1]!, all) > coinsFor(all[i]!, all), "same ordering");
  }
  assert.ok(coinsFor(all[0]!, all) < xpFor(all[0]!, all), "lower rate than XP");

  // And the same bot penalty, or the two would drift into different notions of
  // how well a match went.
  const bots = [seat("me", 1), ...Array.from({ length: 6 }, (_, i) => seat("b" + i, i + 2, true, "easy"))];
  assert.ok(coinsFor(bots[0]!, bots) < coinsFor(all[0]!, all) * 0.25);
});

// --- the level ladder --------------------------------------------------------

test("levels start at 1 and climb with lifetime XP", () => {
  assert.equal(levelFromXp(0).level, 1);
  assert.equal(levelFromXp(LEVELS.BASE_COST - 1).level, 1);
  assert.equal(levelFromXp(LEVELS.BASE_COST).level, 2);
});

test("each level costs more than the last, until the cost stops growing", () => {
  let previous = 0;
  for (let level = 1; level < LEVELS.MAX; level++) {
    const cost = xpForNextLevel(level);
    assert.ok(cost >= previous, "cost never falls");
    assert.ok(cost <= LEVELS.COST_CAP, "and never exceeds the cap");
    previous = cost;
  }
  assert.equal(xpForNextLevel(LEVELS.MAX - 1), LEVELS.COST_CAP);
});

test("the ladder tops out rather than running forever", () => {
  const capped = levelFromXp(10_000_000);
  assert.equal(capped.level, LEVELS.MAX);
  assert.equal(capped.xpForNext, 0, "nothing left to buy");
  assert.equal(capped.xpIntoLevel, 0);
});

test("progress into a level is reported, not just the level", () => {
  // The profile shows a bar; it needs both halves of the fraction.
  const p = levelFromXp(LEVELS.BASE_COST + 100);
  assert.equal(p.level, 2);
  assert.equal(p.xpIntoLevel, 100);
  assert.equal(p.xpForNext, xpForNextLevel(2));
});

test("negative or nonsense XP does not break the ladder", () => {
  assert.equal(levelFromXp(-500).level, 1);
  assert.equal(levelFromXp(0).xpIntoLevel, 0);
});

// --- mastery -----------------------------------------------------------------

test("mastery is earned by playtime, not by winning", () => {
  assert.equal(masteryFor(0).tier, null);
  assert.equal(masteryFor(0).nextName, "Bronze");
  assert.equal(masteryFor(2 * 3600).tier, "bronze");
  assert.equal(masteryFor(6 * 3600).tier, "silver");
  assert.equal(masteryFor(15 * 3600).tier, "gold");
  assert.equal(masteryFor(40 * 3600).tier, "diamond");
});

test("the top mastery tier has nothing after it", () => {
  const top = masteryFor(1000 * 3600);
  assert.equal(top.tier, "diamond");
  assert.equal(top.nextName, null);
  assert.equal(top.secondsToNext, null);
});

test("mastery reports how far the next tier is", () => {
  const halfway = masteryFor(1 * 3600); // one hour in, Bronze is at two
  assert.equal(halfway.tier, null);
  assert.equal(halfway.secondsToNext, 3600);
});
