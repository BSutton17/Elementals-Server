import type { Match } from "../../match/Match.js";
import type { PartySession } from "./types.js";

/**
 * Ranking a table, and naming the kingdom it produced.
 *
 * ⚠️ ORDER IS A SERVER FACT OR IT IS NOTHING. Five of these minigames end with
 * "the last kingdom to do X takes damage", which means the order players
 * finished in decides who gets hurt. Two things follow from that, and both are
 * easy to get wrong:
 *
 *   1. THE CLOCK IS THIS SIDE'S. A finish is stamped with `match.tick` when the
 *      action lands here, never with a timestamp the client sent. A client that
 *      timed itself would be reporting its own score in a game that hands out
 *      damage — and even an honest one would be reporting a number measured on
 *      a different clock.
 *
 *   2. NOT FINISHING IS WORSE THAN FINISHING LAST. A player who never answers
 *      has to rank BELOW everyone who did, not be left out of the ranking. They
 *      are given no `finishedTick`, so they sort to the back — which is the
 *      whole reason `rankedLast` looks at who is enrolled rather than at who is
 *      in `finishOrder`.
 *
 * Latency is not corrected for, deliberately. Every one of these is a party
 * game measured in whole seconds of human reaction; shaving milliseconds off a
 * ping would be false precision, and the correction itself would be a number a
 * client could lie about.
 */

/** Title-cased kingdom name, for a result line. */
export function kingdomLabel(kingdomId: string): string {
  return kingdomId.charAt(0).toUpperCase() + kingdomId.slice(1);
}

/** The kingdom name for a player id, or null when they are gone. */
export function labelFor(match: Match, playerId: string | null): string | null {
  if (!playerId) return null;
  const player = match.gameState?.getPlayer(playerId);
  return player ? kingdomLabel(player.kingdomId) : null;
}

/**
 * Who came last: the worst finisher, or somebody who never finished at all.
 *
 * `succeeded` filters to the players a given game counts as having done the
 * thing — answering correctly, reacting in time — because "last to answer
 * CORRECTLY" is a different question from "last to stop typing".
 */
export function rankedLast(
  session: PartySession,
  succeeded: (state: PartySession["players"][string]) => boolean,
  /**
   * Who is even in the race.
   *
   * ⚠️ BEING OUT IS NOT THE SAME AS BEING SLOW. A player who clicked before
   * the light in Reaction has already been punished for it and is no longer
   * competing; ranking them "last" would mean the actual slowest kingdom walks
   * away and the jumper is hit twice for one mistake. Defaults to everybody,
   * which is what the other games want.
   */
  eligible: (state: PartySession["players"][string]) => boolean = () => true,
): string | null {
  const ids = Object.keys(session.players).filter((id) => eligible(session.players[id]!));
  if (ids.length < 2) return null; // a table of one has no last place

  // Anyone who never got there is last, ahead of anybody who did. More than one
  // is a tie, and a tie is broken by nothing at all: the first in seat order,
  // which is stable and arbitrary in the way a coin is.
  const failed = ids.filter((id) => !succeeded(session.players[id]!));
  if (failed.length > 0) return failed[0]!;

  const ordered = ids
    .filter((id) => session.players[id]!.finishedTick !== null)
    .sort((a, b) => session.players[a]!.finishedTick! - session.players[b]!.finishedTick!);
  return ordered[ordered.length - 1] ?? null;
}

/** Who came first, by the same rules. */
export function rankedFirst(
  session: PartySession,
  succeeded: (state: PartySession["players"][string]) => boolean,
): string | null {
  const ordered = Object.keys(session.players)
    .filter((id) => succeeded(session.players[id]!) && session.players[id]!.finishedTick !== null)
    .sort((a, b) => session.players[a]!.finishedTick! - session.players[b]!.finishedTick!);
  return ordered[0] ?? null;
}
