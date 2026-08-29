import test from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { BotRunner } from "../src/ai/botRunner.js";
import { modelsAvailable } from "../src/ai/modelStore.js";
import { spawnVolcano } from "../src/engine/volcano.js";
import { VOLCANO_TARGET_ID } from "../src/match/GameState.js";
import { TICK } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";

/**
 * Two rules the bots follow that no network could have learned: they leave the
 * table alone for the first fifteen seconds, and they gang up on a volcano.
 *
 * Run through the REAL tick path with production bot code, because both rules
 * live in the controller's `apply` and the thing worth proving is what actually
 * reaches `player.target` in a running match.
 */

const seat = (id: string, kingdomId: string, isBot: boolean): MatchPlayer =>
  ({
    id,
    socketId: null,
    name: id,
    kingdomId,
    ready: true,
    connected: true,
    isBot: isBot || undefined,
    botDifficulty: isBot ? "hard" : undefined,
  }) as never;

function arena(kingdoms: [string, boolean][]): Match {
  const match = new Match("VOLC");
  kingdoms.forEach(([k, bot], i) => match.addPlayer(seat(`p${i}`, k, bot)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  return match;
}

const bots = (match: Match) => match.gameState!.getPlayers().filter((p) => p.id !== "p0");

test("bots pick nobody for the first fifteen seconds", (t) => {
  if (!modelsAvailable()) return t.skip("no trained models on disk");
  const match = arena([
    ["fire", false],
    ["water", true],
    ["nature", true],
    ["ice", true],
  ]);
  const runner = new BotRunner(match);
  assert.equal(runner.start().ready, 3);

  const truce = 15 * TICK.RATE;
  for (let tick = 1; tick <= truce; tick++) {
    runner.tick(tick);
    tickMatch(match, tick);
    for (const bot of bots(match)) {
      assert.equal(
        bot.target,
        null,
        `${bot.id} took a target at tick ${tick}, inside the truce`,
      );
    }
  }
});

test("...and they start fighting once it lifts", (t) => {
  if (!modelsAvailable()) return t.skip("no trained models on disk");
  const match = arena([
    ["fire", false],
    ["water", true],
    ["nature", true],
    ["ice", true],
  ]);
  const runner = new BotRunner(match);
  runner.start();

  // A rule that never lets go would be just as broken as no rule at all.
  let anyTargeted = false;
  for (let tick = 1; tick <= 40 * TICK.RATE && !anyTargeted; tick++) {
    runner.tick(tick);
    tickMatch(match, tick);
    anyTargeted = bots(match).some((b) => b.target !== null);
    if (anyTargeted) {
      assert.ok(
        tick >= 15 * TICK.RATE,
        `a bot targeted at tick ${tick}, before the truce was over`,
      );
    }
  }
  assert.ok(anyTargeted, "no bot ever picked a target after the truce");
});

test("a standing volcano pulls the whole table onto it", (t) => {
  if (!modelsAvailable()) return t.skip("no trained models on disk");
  const match = arena([
    ["magma", false],
    ["water", true],
    ["nature", true],
    ["ice", true],
  ]);
  const runner = new BotRunner(match);
  runner.start();

  // Past the truce first, so this is measuring the volcano rule and not it.
  for (let tick = 1; tick <= 16 * TICK.RATE; tick++) {
    runner.tick(tick);
    tickMatch(match, tick);
  }
  spawnVolcano(match, "p0", 30 * TICK.RATE);

  // At 50% a second, three bots all failing to commit for ten seconds is a
  // 1-in-a-billion accident rather than a coin flip.
  let ticked = match.tick;
  for (let i = 0; i < 10 * TICK.RATE; i++) {
    ticked += 1;
    runner.tick(ticked);
    tickMatch(match, ticked);
  }
  for (const bot of bots(match)) {
    assert.equal(bot.target, VOLCANO_TARGET_ID, `${bot.id} never committed to the volcano`);
  }
});

test("once committed they do not wander off it", (t) => {
  if (!modelsAvailable()) return t.skip("no trained models on disk");
  const match = arena([
    ["magma", false],
    ["water", true],
    ["nature", true],
  ]);
  const runner = new BotRunner(match);
  runner.start();
  for (let tick = 1; tick <= 16 * TICK.RATE; tick++) {
    runner.tick(tick);
    tickMatch(match, tick);
  }
  spawnVolcano(match, "p0", 60 * TICK.RATE);

  let ticked = match.tick;
  let committed = false;
  for (let i = 0; i < 20 * TICK.RATE; i++) {
    ticked += 1;
    runner.tick(ticked);
    tickMatch(match, ticked);
    const all = bots(match).every((b) => b.target === VOLCANO_TARGET_ID);
    if (all) committed = true;
    // ⚠️ THE ACTUAL PROPERTY: not that they arrive, but that they STAY. A bot
    // re-deciding twice a second drifts back to the weakest kingdom and leaves
    // the mountain to erupt on everyone.
    if (committed && match.gameState!.volcano) {
      for (const bot of bots(match)) {
        assert.equal(
          bot.target,
          VOLCANO_TARGET_ID,
          `${bot.id} wandered off the volcano at tick ${ticked}`,
        );
      }
    }
  }
  assert.ok(committed, "the bots never committed at all");
});

test("the volcano actually takes damage from the bots aimed at it", (t) => {
  if (!modelsAvailable()) return t.skip("no trained models on disk");
  // ⚠️ THE POINT OF THE WHOLE RULE. Aiming at the mountain is worth nothing if
  // the action mask then refuses every attack, which is exactly what happened
  // before: the volcano is not a kingdom, so the "do I have a target" test in
  // `legality.ts` came back false and a committed bot stood and watched.
  const match = arena([
    ["magma", false],
    ["fire", true],
    ["electricity", true],
    ["water", true],
  ]);
  const runner = new BotRunner(match);
  runner.start();
  for (let tick = 1; tick <= 16 * TICK.RATE; tick++) {
    runner.tick(tick);
    tickMatch(match, tick);
  }
  spawnVolcano(match, "p0", 90 * TICK.RATE);
  const full = match.gameState!.volcano!.maxHp;

  // Count what actually lands, rather than reading the HP at the end: a volcano
  // that erupts on its timer and one that is broken both leave `volcano` null.
  let dealt = 0;
  match.gameState!.events.on((e) => {
    if (e.type === "volcanoDamaged") dealt += (e as { amount: number }).amount;
  });

  let ticked = match.tick;
  for (let i = 0; i < 60 * TICK.RATE && match.gameState!.volcano; i++) {
    ticked += 1;
    runner.tick(ticked);
    tickMatch(match, ticked);
  }
  // ⚠️ HALF, NOT "SOMETHING". Merely landing a hit was the old bar and it
  // hid the real behaviour: the bots aimed at the mountain and then went back
  // to buying citizens, because nothing in the observation describes a volcano
  // and the policy has never seen one. Four to eight casts across four seats in
  // a thirty-second window, and the timer always won. With the reflex they
  // break it outright; half its health is a floor that leaves room for a poor
  // draw without letting the old behaviour back in.
  assert.ok(
    dealt >= full / 2,
    `the bots barely touched the volcano: ${dealt} of ${full}`,
  );
});

test("Magma is never pulled onto its own volcano", (t) => {
  if (!modelsAvailable()) return t.skip("no trained models on disk");
  // It is the one kingdom the eruption spares, and the engine refuses the
  // target — a bot that kept trying would burn a decision a second on it.
  const match = arena([
    ["magma", true],
    ["water", true],
    ["nature", false],
  ]);
  const runner = new BotRunner(match);
  runner.start();
  for (let tick = 1; tick <= 16 * TICK.RATE; tick++) {
    runner.tick(tick);
    tickMatch(match, tick);
  }
  spawnVolcano(match, "p0", 40 * TICK.RATE);

  let ticked = match.tick;
  for (let i = 0; i < 10 * TICK.RATE; i++) {
    ticked += 1;
    runner.tick(ticked);
    tickMatch(match, ticked);
    assert.notEqual(
      match.gameState!.getPlayer("p0")!.target,
      VOLCANO_TARGET_ID,
      "Magma aimed at its own volcano",
    );
  }
});
