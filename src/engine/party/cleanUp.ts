import { PARTY, TICK } from "../../data/balance.js";
import { param } from "../parameters.js";
import { botDifficulty } from "./bots.js";
import type { PartyActionResult, PartyGame, PartySetup } from "./types.js";

/**
 * Clean up the mess.
 *
 * Something is spilled across your screen. Wipe it away with a finger or the
 * mouse. It costs nothing but visibility, and it is gone in twenty seconds
 * whatever you do.
 *
 * ⚠️ THE SPLATS ARE PLACED HERE AND WIPED HERE. The client could perfectly well
 * own a purely cosmetic mess — but then a bot could not "clean" one, the
 * progress bar would be a local fiction, and two players comparing screens
 * would see different messes. Placing them server-side costs a few dozen
 * numbers on the wire and makes the whole thing one shared, inspectable fact.
 *
 * ⚠️ AND IT NEVER TAKES ANYTHING. No damage, no gold, no penalty for ignoring
 * it. Party Mode needs at least one event that is pure texture: something
 * happens, everybody swears at their screen, nobody loses a match over it.
 */

export interface Splat {
  id: number;
  /** Fractions of the screen, so every size of display gets the same mess. */
  x: number;
  y: number;
  r: number;
  /** Which of the blob shapes the client draws, and how far it is turned. */
  shape: number;
  rotation: number;
}

export function buildMess(rng: () => number, count: number): Splat[] {
  const splats: Splat[] = [];
  for (let i = 0; i < count; i++) {
    splats.push({
      id: i,
      x: 0.08 + rng() * 0.84,
      y: 0.12 + rng() * 0.76,
      // Big enough to be in the way, not so big that two of them black out the
      // screen: this is meant to obscure, not to blind.
      r: 0.07 + rng() * 0.09,
      shape: Math.floor(rng() * 4),
      rotation: rng() * 360,
    });
  }
  return splats;
}

export const CLEAN_UP_GAME: PartyGame = {
  id: "cleanUp",
  description: "Clean up the mess",
  timedSeconds: PARTY.CLEAN_UP_SECONDS,
  maxSeconds: PARTY.CLEAN_UP_SECONDS + 2,
  // ⚠️ PRODUCTION KEEPS RUNNING. The mess only costs visibility; stopping the
  // economy on top of that would turn a bit of slapstick into a real tax.
  stopsProduction: false,
  // A dirty screen makes playing harder. It does not stop anybody playing.
  holdsAttacks: false,

  setup(match, players) {
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) {
      // A mess each. A shared one would mean everybody's screen is dirty in the
      // same places, and cleaning would look synchronised.
      perPlayer[player.id] = {
        splats: buildMess(match.rng, param("party.messSplats", PARTY.MESS_SPLATS)),
        wiped: [],
      };
    }
    return { shared: {}, perPlayer };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "wipe") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "All clean" };

    const id = typeof action.splatId === "number" ? Math.floor(action.splatId) : -1;
    const splats = me.data.splats as Splat[];
    if (!splats.some((s) => s.id === id)) return { ok: false, error: "No such mess" };

    const wiped = me.data.wiped as number[];
    if (!wiped.includes(id)) wiped.push(id);

    // Cleaning it ALL just ends it early — the reward for scrubbing is getting
    // your screen back, which is reward enough.
    if (wiped.length >= splats.length) {
      me.done = true;
      me.outcome = "won";
      me.finishedTick = match.tick;
    }
    return { ok: true };
  },

  bot(match, session, player) {
    const me = session.players[player.id];
    if (!me || me.done) return;

    // ⚠️ A BOT "CLEANS" BY DOING NOTHING FOR A WHILE. There is no screen to
    // wipe and nothing to be good at, so what difficulty buys here is how long
    // the bot is inconvenienced — the same seconds a person would spend
    // scrubbing. Easy takes seven, medium six, hard four.
    if (me.data.botDoneTick === undefined) {
      const difficulty = botDifficulty(match, player.id);
      const seconds = difficulty === "easy" ? 7 : difficulty === "medium" ? 6 : 4;
      me.data.botDoneTick = match.tick + Math.round(seconds * TICK.RATE);
      return;
    }
    if (match.tick < (me.data.botDoneTick as number)) return;

    me.data.wiped = (me.data.splats as Splat[]).map((s) => s.id);
    me.done = true;
    me.outcome = "won";
    me.finishedTick = match.tick;
  },

  forceFinish(match, session, player) {
    // The mess washes off on its own at twenty seconds. Nobody fails this.
    const me = session.players[player.id];
    if (!me) return;
    me.done = true;
    me.outcome = "won";
    me.finishedTick = match.tick;
  },

  result() {
    return null; // "none"
  },
};
