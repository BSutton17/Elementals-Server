import { PARTY } from "../../data/balance.js";
import { applyDamage } from "../combat.js";
import { param } from "../parameters.js";
import type { PartyActionResult, PartyGame, PartySetup } from "./types.js";

/**
 * Don't move.
 *
 * Six seconds. Touch anything — a button, the mouse, the screen — and the
 * castle takes five thousand. Gold keeps coming in, so there is nothing to gain
 * by playing and everything to lose by fidgeting.
 *
 * ⚠️ THE CLIENT REPORTS THE TWITCH; IT DOES NOT DECIDE THE PENALTY. Only the
 * player's own machine can see a mouse move, so this is the one game where the
 * client is the sole witness — which is exactly why the SERVER decides what a
 * report is worth, refuses a second one, and ignores anything arriving after
 * the six seconds are up. A client that could apply its own damage could also
 * apply somebody else's.
 *
 * ⚠️ AND A BOT ALWAYS PASSES. Bots have no hands. Rolling a failure for them
 * would be inventing a mistake nobody made, and in a game where the only
 * outcome is "did you sit still", a bot that twitches is a bot that lies.
 */
export const DONT_MOVE_GAME: PartyGame = {
  id: "dontMove",
  description: "Don't move",
  timedSeconds: PARTY.DONT_MOVE_SECONDS,
  maxSeconds: PARTY.DONT_MOVE_SECONDS + 2,
  // Gold still comes in — that is the whole tension. Sitting still is free, and
  // the six seconds cost nothing but nerve.
  stopsProduction: false,
  // Six seconds of stillness is the game; freezing the match around it is not.
  holdsAttacks: false,

  setup(_match, players) {
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) perPlayer[player.id] = { moved: false };
    return { shared: {}, perPlayer };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "moved") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "Already still" };

    me.done = true;
    me.outcome = "lost";
    me.finishedTick = match.tick;
    me.data.moved = true;
    applyDamage(player, param("party.dontMovePenalty", PARTY.DONT_MOVE_PENALTY), {
      tick: match.tick,
    });
    return { ok: true };
  },

  bot(_match, session, player) {
    // Nothing to do: a bot cannot move, so it simply survives to the end and is
    // marked still by `forceFinish` with everybody else who managed it.
    void session;
    void player;
  },

  forceFinish(match, session, player) {
    // Reaching the end without reporting a twitch IS the win.
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
