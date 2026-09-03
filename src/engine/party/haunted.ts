import { PARTY, TICK } from "../../data/balance.js";
import { param } from "../parameters.js";
import type { Match } from "../../match/Match.js";
import type { PlayerState } from "../../match/playerState.js";
import type { PartyGame, PartySetup } from "./types.js";

/**
 * A chill runs down your spine…
 *
 * Every eliminated player still sitting in the room comes back as a ghost for
 * twenty-five seconds: forty-five citizens, a full kit, and free rein to attack
 * anybody. They cannot be targeted and cannot be hurt. Then they are dead
 * again.
 *
 * ⚠️ A GHOST IS STILL ELIMINATED, AND THAT IS NOT A DETAIL — IT IS THE WHOLE
 * IMPLEMENTATION. `resolveWinner` ends the match when at most one player is not
 * eliminated, so "bring them back to life" by clearing `eliminated` would do
 * two catastrophic things at once: it would stop a finished match from ending,
 * and a ghost left standing when the last living kingdom fell would be declared
 * the WINNER of a game they lost minutes ago. So nothing about their
 * elimination changes. They are granted a separate, temporary right to act —
 * `ghostUntilTick` — and every rule that asks "are you out?" still gets yes.
 *
 * ⚠️ AND THEY CANNOT BE HIT BACK. Not out of kindness: a ghost has no stake
 * left, so damage to them means nothing, and letting the living spend an
 * ultimate on a target that cannot lose would make Haunted a punishment for the
 * people still playing.
 */
export const HAUNTED_GAME: PartyGame = {
  id: "haunted",
  description: "A chill runs down your spine…",
  timedSeconds: PARTY.HAUNTED_SECONDS,
  maxSeconds: PARTY.HAUNTED_SECONDS + 2,
  stopsProduction: false,
  // The ghosts are raised to attack. Holding attacks would forbid the entire point.
  holdsAttacks: false,

  canStart(match) {
    // Nobody to raise, nothing to haunt.
    return hasGhostsToRaise(match);
  },

  setup(match, players) {
    // ⚠️ THE LIVING ARE ENROLLED, THE DEAD ARE RAISED. `players` is the living
    // kingdoms (the session only ever enrols those), and for them this game is
    // pure weather: nothing to do, nothing to win. The ghosts are found
    // separately, because by definition they are not in that list.
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) perPlayer[player.id] = {};

    const until = match.tick + Math.round(param("party.hauntedSeconds", PARTY.HAUNTED_SECONDS) * TICK.RATE);
    const raised: string[] = [];
    for (const ghost of hauntable(match)) {
      ghost.ghostUntilTick = until;
      ghost.economy.citizens = param("party.ghostCitizens", PARTY.GHOST_CITIZENS);
      raised.push(ghost.id);
    }

    return { shared: { ghosts: raised, untilTick: until }, perPlayer };
  },

  act() {
    // There is nothing to press. A ghost plays the ORDINARY game — the same
    // ability bar, the same targeting — so its actions go through the normal
    // handlers, not through this one.
    return { ok: false, error: "Nothing to do but watch" };
  },

  bot() {
    // Same for a bot: a raised bot is driven by the ordinary AI runner, which
    // needs no help from here.
  },

  result() {
    return "You feel a ghostly presence fade…";
  },
};

/**
 * Who can be raised: eliminated, still connected, not a spectator.
 *
 * ⚠️ STILL CONNECTED MATTERS. Raising somebody who closed the tab twenty
 * minutes ago produces a kingdom that stands there doing nothing while the
 * living wonder why it is glowing.
 */
export function hauntable(match: Match) {
  const state = match.gameState;
  if (!state) return [];
  const seats = new Map(match.getPlayers().map((seat) => [seat.id, seat]));
  return state.getPlayers().filter((player) => {
    if (!player.eliminated) return false;
    const seat = seats.get(player.id);
    return seat !== undefined && seat.connected && seat.spectator !== true;
  });
}

/**
 * True while this player is a ghost: out of the match, but allowed to act.
 *
 * Takes a PlayerState and a tick rather than a Match, so the three gates that
 * need it — casting, aiming, income — can ask without reaching for the match
 * they do not all have.
 */
export function isGhostAt(player: PlayerState, tick: number): boolean {
  if (!player.eliminated) return false;
  return player.ghostUntilTick !== undefined && tick < player.ghostUntilTick;
}

/** The same question, from a match. */
export function isGhost(match: Match, playerId: string): boolean {
  const player = match.gameState?.getPlayer(playerId);
  return player !== undefined && isGhostAt(player, match.tick);
}

/**
 * Sends the ghosts back, and is called every tick rather than only at the end.
 *
 * A ghost's welcome has to expire on its own clock: the session can be cleared
 * early, the match can end, a ghost can be raised and the room emptied. Tying
 * their return to the session resolving would leave a dead player attacking
 * forever if anything ended unusually.
 */
export function tickGhosts(match: Match): void {
  const state = match.gameState;
  if (!state) return;
  for (const player of state.getPlayers()) {
    if (player.ghostUntilTick === undefined) continue;
    if (match.tick < player.ghostUntilTick) continue;
    player.ghostUntilTick = undefined;
    // The citizens go with them; a ghost's economy was a loan.
    player.economy.citizens = 0;
    player.economy.incomePerTick = 0;
  }
}

/** Whether Haunted can run at all: it needs somebody to raise. */
export function hasGhostsToRaise(match: Match): boolean {
  return hauntable(match).length > 0;
}
