import test from "node:test";
import assert from "node:assert/strict";
import { BOT_NAMES, pickBotName } from "../src/net/lobbyHandlers.js";

/**
 * Bot names come from a POOL, not a running order.
 *
 * ⚠️ THE LIST WAS BEING READ AS A SEQUENCE. `freeBotName` used
 * `BOT_NAMES.find(n => !used.has(n))`, which takes the first free name, so
 * every lobby filled with bots got Ember, Cinder, Frost, Gale in that order,
 * every match. Twenty-seven names read as four.
 */

test("a name is picked at random rather than taken in list order", () => {
  // The old implementation returned BOT_NAMES[0] regardless of the roll, so a
  // roll that lands elsewhere is exactly what it could not do.
  assert.equal(pickBotName([], () => 0), BOT_NAMES[0]);
  assert.equal(pickBotName([], () => 0.999), BOT_NAMES[BOT_NAMES.length - 1]);
  const middle = pickBotName([], () => 0.5);
  assert.notEqual(middle, BOT_NAMES[0], "a mid roll must not return the first name");
  assert.ok(BOT_NAMES.includes(middle));
});

test("filling a lobby does not produce the same four names every time", () => {
  // The behaviour actually complained about: add four bots, repeatedly.
  const fill = (): string[] => {
    const taken: string[] = [];
    for (let i = 0; i < 4; i++) taken.push(pickBotName(taken));
    return taken;
  };
  const runs = new Set<string>();
  for (let i = 0; i < 40; i++) runs.add(fill().join(","));
  assert.ok(
    runs.size > 1,
    `forty lobbies produced the same roster every time: ${[...runs][0]}`,
  );
});

test("a name in use is never handed out twice", () => {
  // Whatever the roll, an occupied name must not come back — names identify
  // seats in the lobby.
  const taken = BOT_NAMES.slice(0, BOT_NAMES.length - 1);
  for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
    assert.equal(pickBotName(taken, () => roll), BOT_NAMES[BOT_NAMES.length - 1]);
  }
});

test("a full pool falls back instead of returning a duplicate or undefined", () => {
  const name = pickBotName(BOT_NAMES, () => 0);
  assert.ok(name.startsWith("Bot "), `expected a fallback name, got ${name}`);
  assert.equal(BOT_NAMES.includes(name), false);
});

test("the pool is big enough to fill a lobby without exhausting", () => {
  // Seven bots is the largest a match can hold; the fallback should be a
  // safety net rather than something a normal lobby reaches.
  assert.ok(BOT_NAMES.length >= 7, `only ${BOT_NAMES.length} names`);
  assert.equal(new Set(BOT_NAMES).size, BOT_NAMES.length, "the pool has duplicates");
});
