import { PARTY, TICK } from "../../data/balance.js";
import { param } from "../parameters.js";
import { botDifficulty } from "./bots.js";
import type { PartyActionResult, PartyGame, PartySetup } from "./types.js";

/**
 * Clean up the mess.
 *
 * The whole screen is covered, and it clears only where you actually wipe. It
 * costs nothing but visibility, and it is gone in twenty seconds whatever you
 * do.
 *
 * ⚠️ A GRID THAT COVERS EVERYTHING, NOT A HANDFUL OF BLOBS. Seven blobs
 * scattered over a phone left most of the screen clean, so "cleaning" was
 * really tapping seven targets — whack-a-mole, and over in a second. The mess is
 * now a tile per patch of screen, every tile filled at the start, and a swipe
 * clears the tiles it passes over. What is left is the shape of where you have
 * not been, which is what makes it feel like wiping something.
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

/**
 * One tile per patch of screen, covering all of it.
 *
 * The jitter is what stops it reading as a grid: each tile's centre wanders
 * inside its own cell and its radius varies, so the edges between neighbours
 * are ragged. They are drawn through a goo filter on the client, which melts
 * overlapping tiles into one continuous spill — so what the player sees is a
 * covered screen, and what they clear is a tile at a time.
 *
 * ⚠️ THE RADIUS MUST OVERSHOOT THE CELL. A tile exactly the size of its cell
 * leaves pinholes at every corner as soon as the centres are jittered, and a
 * screen of pinholes looks like a rendering fault rather than a mess.
 */
export function buildMess(rng: () => number, columns: number, rows: number): Splat[] {
  const splats: Splat[] = [];
  const cellW = 1 / columns;
  const cellH = 1 / rows;
  // Half a cell across the diagonal, plus a third again for the jitter and the
  // ragged edge. Expressed against the WIDTH because that is what the client
  // measures `r` in.
  const reach = Math.hypot(cellW, cellH) * 0.5 * 1.35;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      splats.push({
        id: row * columns + col,
        x: (col + 0.5) * cellW + (rng() - 0.5) * cellW * 0.35,
        y: (row + 0.5) * cellH + (rng() - 0.5) * cellH * 0.35,
        r: reach * (0.85 + rng() * 0.3),
        shape: Math.floor(rng() * 4),
        rotation: rng() * 360,
      });
    }
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
        splats: buildMess(
          match.rng,
          param("party.messColumns", PARTY.MESS_COLUMNS),
          param("party.messRows", PARTY.MESS_ROWS),
        ),
        wiped: [],
      };
    }
    return { shared: {}, perPlayer };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "wipe") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "All clean" };

    // ⚠️ A SWIPE CLEARS MANY TILES AT ONCE, SO THE ACTION CARRIES A LIST. One
    // id per tile would be one round trip per tile: a single flick across a
    // phone crosses a dozen, and at twenty of those a second the socket would
    // be carrying more wiping than game. `splatId` is still accepted because a
    // single tap is still one tile.
    const ids =
      Array.isArray(action.ids)
        ? (action.ids as unknown[]).filter((v): v is number => typeof v === "number")
        : typeof action.splatId === "number"
          ? [action.splatId]
          : [];
    if (ids.length === 0) return { ok: false, error: "Nothing wiped" };

    const splats = me.data.splats as Splat[];
    const wiped = me.data.wiped as number[];
    let any = false;
    for (const raw of ids) {
      const id = Math.floor(raw);
      if (!splats.some((s) => s.id === id)) continue;
      if (!wiped.includes(id)) wiped.push(id);
      any = true;
    }
    if (!any) return { ok: false, error: "No such mess" };

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
