import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { buildMatchSnapshot, stampCastlePaint } from "../src/match/snapshot.js";
import { COSMETICS } from "../src/data/cosmetics.js";
import type { MatchPlayer } from "../src/match/types.js";

/**
 * Bots actually WEARING their skins.
 *
 * ⚠️ THE ROLL BEING RIGHT PROVES NOTHING ON ITS OWN. botSkins.test.ts checks
 * the odds, but a correct roll behind a snapshot that never carries the result
 * is a feature nobody can see — and "I cannot see the bot skins" is exactly the
 * report that prompted this file. This covers the wiring instead: a bot seat in
 * a match comes out of `buildMatchSnapshot` with paint on it.
 */

const seat = (id: string, kingdomId: string, isBot = false): MatchPlayer => ({
  id,
  socketId: isBot ? null : `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
  ...(isBot ? { isBot: true } : {}),
});

/** A kingdom with a full set, so the roll can fire at all. */
function fullSetKingdom(): string {
  const byKingdom = new Map<string, { uncommon: number; rare: number; legendary: number }>();
  for (const c of COSMETICS) {
    if (c.slot !== "castle" || !c.kingdomId || c.rarity === "common") continue;
    const row = byKingdom.get(c.kingdomId) ?? { uncommon: 0, rare: 0, legendary: 0 };
    row[c.rarity as "uncommon" | "rare" | "legendary"]++;
    byKingdom.set(c.kingdomId, row);
  }
  for (const [id, r] of byKingdom) {
    if (r.uncommon >= 1 && r.rare >= 2 && r.legendary >= 1) return id;
  }
  throw new Error("fixture: no kingdom has a full castle set");
}

describe("bots wear their skins in the snapshot", () => {
  test("a bot seat comes back with paint on it", () => {
    const kingdomId = fullSetKingdom();

    /* The roll is seeded from the room code and the seat id, so a single room
       is a single sample — and one in four of those is legitimately the default
       castle. Rooms are varied until a skinned bot turns up; if the wiring is
       broken, none of them ever will be. */
    let painted = 0;
    let seen = 0;
    for (let i = 0; i < 40; i++) {
      const match = new Match(`R${i.toString().padStart(3, "0")}`);
      match.addPlayer(seat("p0", "plains"));
      match.addPlayer(seat(`bot-${i}`, kingdomId, true));
      match.hostId = "p0";

      const snap = buildMatchSnapshot(match, "p0");
      const bot = snap.players.find((p) => p.id === `bot-${i}`);
      assert.ok(bot, "the bot must be in the snapshot");
      seen++;
      if (bot.castlePaint) {
        painted++;
        assert.ok(bot.castlePaint.decor ?? bot.castlePaint.fill ?? bot.castlePaint.gradient);
      }
    }

    assert.equal(seen, 40);
    assert.ok(painted > 0, "no bot in 40 rooms got a skin: the snapshot wiring is broken");
    /* Roughly three in four, and this is a wiring test rather than a
       distribution one, so the bound is loose enough not to flake. */
    assert.ok(painted >= 20, `only ${painted}/40 bots were painted`);
  });

  test("a human with no loadout still gets the default", () => {
    const match = new Match("1234");
    match.addPlayer(seat("p0", fullSetKingdom()));
    match.hostId = "p0";

    const snap = buildMatchSnapshot(match, "p0");
    const me = snap.players.find((p) => p.id === "p0");
    assert.ok(me);
    // ⚠️ PEOPLE WEAR WHAT THEY EQUIPPED, AND NOTHING ELSE. If the bot roll ever
    // leaked onto human seats, players would be handed skins they never bought.
    assert.equal(me.castlePaint, undefined);
  });

  test("a bot in a kingdom without a full set is the default", () => {
    const withSkins = new Set(
      COSMETICS.filter((c) => c.slot === "castle" && c.rarity !== "common").map((c) => c.kingdomId),
    );
    const bare = COSMETICS.find(
      (c) => c.slot === "castle" && c.kingdomId && !withSkins.has(c.kingdomId),
    )?.kingdomId;
    if (!bare) return; // every kingdom has skins now: nothing left to check

    const match = new Match("1234");
    match.addPlayer(seat("p0", "plains"));
    match.addPlayer(seat("bot-1", bare, true));
    match.hostId = "p0";

    const snap = buildMatchSnapshot(match, "p0");
    assert.equal(snap.players.find((p) => p.id === "bot-1")?.castlePaint, undefined);
  });

  test("stamping puts the paint on the seats, which is what match:started sends", () => {
    const kingdomId = fullSetKingdom();

    /* ⚠️ THE SEATS ARE THE DELIVERY VEHICLE. `state:sync` is built from the
       engine's PlayerState and carries no cosmetics, so if the paint is not on
       the seat when `match:started` goes out, the client never gets it at all
       and every castle on the battlefield renders standard. */
    let painted = 0;
    for (let i = 0; i < 40; i++) {
      const match = new Match(`S${i.toString().padStart(3, "0")}`);
      match.addPlayer(seat("p0", "plains"));
      match.addPlayer(seat(`bot-${i}`, kingdomId, true));
      match.hostId = "p0";

      stampCastlePaint(match);

      const bot = match.getPlayers().find((p) => p.id === `bot-${i}`);
      assert.ok(bot, "the bot must still be seated");
      if (bot.castlePaint) painted++;
    }
    assert.ok(painted >= 20, `only ${painted}/40 bot seats were stamped`);
  });

  test("stamping agrees with the snapshot, so the two paths cannot drift", () => {
    const kingdomId = fullSetKingdom();
    const match = new Match("1234");
    match.addPlayer(seat("p0", "plains"));
    match.addPlayer(seat("bot-1", kingdomId, true));
    match.hostId = "p0";

    const fromSnapshot = buildMatchSnapshot(match, "p0").players.find((p) => p.id === "bot-1")
      ?.castlePaint;
    stampCastlePaint(match);
    const fromSeat = match.getPlayers().find((p) => p.id === "bot-1")?.castlePaint;

    assert.deepEqual(fromSeat, fromSnapshot);
  });
});
