import test from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { BotRunner } from "../src/ai/botRunner.js";
import { modelsAvailable } from "../src/ai/modelStore.js";
import { spawnVolcano } from "../src/engine/volcano.js";
import { VOLCANO_TARGET_ID } from "../src/match/GameState.js";
import { isGhost, startParty } from "../src/engine/party/index.js";
import { PARTY, TICK } from "../src/data/balance.js";
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

/**
 * Don't Move asks every human to touch nothing for six seconds and bills them
 * five thousand health if they do. A bot has no hands to hold still, so left to
 * itself it spent those six seconds buying and attacking a table that was
 * obeying the rules — the one game whose entire content is "do not act" was the
 * one game where the AI acted freely.
 */
test("the AI sits out Don't Move, like everybody else", (t) => {
  if (!modelsAvailable()) return t.skip("no trained models on disk");
  const match = arena([
    ["fire", false],
    ["water", true],
    ["nature", true],
    ["ice", true],
  ]);
  // ⚠️ THE ROLL STAYS OFF; THE SESSION IS STARTED BY HAND. `startParty` does not
  // consult `partyModeEnabled` — only the clock does — so leaving it off means
  // no RANDOM minigame can land during the warm-up below and refuse the one this
  // test is about. It did exactly that the moment the first roll moved to
  // twenty seconds, which is also how long the warm-up runs.
  const runner = new BotRunner(match);
  runner.start();

  // Past the opening truce first, so the bots are demonstrably willing to act —
  // otherwise this test would pass on a match where nothing happens anyway.
  for (let tick = 1; tick <= 20 * TICK.RATE; tick++) {
    runner.tick(tick);
    tickMatch(match, tick);
  }
  const acting = bots(match).some((b) => b.target !== null);
  assert.ok(acting, "the bots never engaged, so this proves nothing");

  const before = bots(match).map((b) => ({
    id: b.id,
    gold: b.economy.currency,
    citizens: b.economy.citizens,
    shield: b.castle.shield,
  }));

  startParty(match, "dontMove");
  const start = match.tick;
  for (let tick = start + 1; tick <= start + PARTY.DONT_MOVE_SECONDS * TICK.RATE; tick++) {
    runner.tick(tick);
    tickMatch(match, tick);
  }

  for (const was of before) {
    const now = match.gameState!.getPlayer(was.id)!;
    // Gold RISES — production is deliberately left running through Don't Move —
    // so what is asserted is that nothing was SPENT: no purchase, no cast.
    assert.ok(
      now.economy.currency >= was.gold,
      `${was.id} spent gold during Don't Move`,
    );
    assert.equal(now.economy.citizens, was.citizens, `${was.id} bought citizens`);
    assert.ok(now.castle.shield <= was.shield, `${was.id} bought a shield`);
  }
});

test("...and goes straight back to playing when it ends", (t) => {
  // A freeze that never lifts would be a far worse bug than the one it fixes,
  // and it would look identical for the first six seconds.
  if (!modelsAvailable()) return t.skip("no trained models on disk");
  const match = arena([
    ["fire", false],
    ["water", true],
    ["nature", true],
    ["ice", true],
  ]);
  // ⚠️ THE ROLL STAYS OFF; THE SESSION IS STARTED BY HAND. `startParty` does not
  // consult `partyModeEnabled` — only the clock does — so leaving it off means
  // no RANDOM minigame can land during the warm-up below and refuse the one this
  // test is about. It did exactly that the moment the first roll moved to
  // twenty seconds, which is also how long the warm-up runs.
  const runner = new BotRunner(match);
  runner.start();
  for (let tick = 1; tick <= 20 * TICK.RATE; tick++) {
    runner.tick(tick);
    tickMatch(match, tick);
  }

  startParty(match, "dontMove");
  // Run it out completely, past the result-banner linger, so the session clears.
  const budget = (PARTY.DONT_MOVE_SECONDS + PARTY.RESULT_SECONDS + 3) * TICK.RATE;
  for (let i = 0; i < budget; i++) {
    runner.tick(match.tick + 1);
    tickMatch(match, match.tick + 1);
  }
  assert.equal(match.gameState!.party, null, "the session never cleared");

  const before = bots(match).map((b) => b.economy.currency);
  for (let i = 0; i < 15 * TICK.RATE; i++) {
    runner.tick(match.tick + 1);
    tickMatch(match, match.tick + 1);
  }
  const after = bots(match).map((b) => b.economy.currency);
  // Somebody spent something: the AI is playing again.
  assert.ok(
    after.some((gold, i) => gold < before[i]!) ||
      bots(match).some((b) => b.economy.citizens > 0),
    "the AI never resumed after Don't Move",
  );
})

/**
 * Haunted raises the dead — including the bots.
 *
 * ⚠️ REPORTED FROM A LOBBY OF NOTHING BUT BOTS: the banner announced a haunting
 * and the graveyard stood still. The cause is the same design decision that
 * makes ghosts work at all — `eliminated` stays TRUE while one is raised, which
 * is what keeps `resolveWinner` correct and hands them immunity and
 * untargetability for free. The cost is that EVERY "skip the dead" check skips
 * ghosts too, and the AI had two of them: one in the runner, one in the
 * controller. Fixing either alone looks right and changes nothing.
 */
test("a bot ghost actually plays while Haunted is running", (t) => {
  if (!modelsAvailable()) return t.skip("no trained models on disk");
  const match = arena([
    ["fire", true],
    ["water", true],
    ["nature", true],
    ["ice", true],
  ]);
  const runner = new BotRunner(match);
  runner.start();

  // Warm up past the opening truce so the bots are demonstrably willing to act.
  for (let tick = 1; tick <= 20 * TICK.RATE; tick++) {
    runner.tick(tick);
    tickMatch(match, tick);
  }

  // Kill one off, then raise it.
  const dead = match.gameState!.getPlayer("p3")!;
  dead.eliminated = true;
  dead.castle.hp = 0;
  dead.target = null;

  assert.ok(startParty(match, "haunted"), "Haunted refused to start with a corpse to raise");
  assert.equal(isGhost(match, dead.id), true, "the dead bot was not raised");

  // ⚠️ THE ASSERTION IS "IT TOOK A TARGET", AND NOTHING ELSE WILL DO. The first
  // version of this test also accepted the ghost's GOLD changing — which proved
  // nothing, because Haunted lends a ghost 45 citizens and their income lands on
  // the very next tick. It passed with the bug deliberately put back. Picking a
  // target is a decision only the controller makes.
  for (let i = 0; i < PARTY.HAUNTED_SECONDS * TICK.RATE; i++) {
    runner.tick(match.tick + 1);
    tickMatch(match, match.tick + 1);
    if (dead.target !== null) break;
  }

  assert.notEqual(dead.target, null, "the ghost stood still for the entire haunting");
});

test("...and goes back to being dead when the haunting ends", () => {
  // A ghost that kept acting after its time would be worse than one that never
  // acted: a kingdom that lost the match still fighting in it.
  const match = arena([
    ["fire", false],
    ["water", true],
  ]);
  const dead = match.gameState!.getPlayer("p1")!;
  dead.eliminated = true;
  dead.castle.hp = 0;
  startParty(match, "haunted");
  assert.equal(isGhost(match, dead.id), true);

  for (let i = 0; i < (PARTY.HAUNTED_SECONDS + 2) * TICK.RATE; i++) {
    tickMatch(match, match.tick + 1);
  }
  assert.equal(isGhost(match, dead.id), false, "the ghost never went back to the grave");
})
