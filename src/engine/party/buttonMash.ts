import { PARTY, TICK } from "../../data/balance.js";
import { applyDamage } from "../combat.js";
import { healCastle } from "../abilities.js";
import { param } from "../parameters.js";
import { kingdomLabel } from "./results.js";
import { between, botDifficulty, MASH_CPS } from "./bots.js";
import type { Match } from "../../match/Match.js";
import type { PartyActionResult, PartyGame, PartySession, PartySetup } from "./types.js";

/**
 * Click as fast as you can.
 *
 * Five seconds. Most clicks heals a thousand, fewest takes two.
 *
 * ⚠️ CLICKS ARE BATCHED, AND THE RATE IS CAPPED. One socket message per click
 * would be forty messages a second per player and three hundred across a full
 * table, for a game that lasts five seconds — so the client sends a running
 * count a few times a second instead. That means the count is a number the
 * client chose, which is why it is not taken at face value: each report may add
 * at most `MASH_MAX_PER_SECOND` clicks' worth for the time that has actually
 * passed. A tab claiming a thousand presses gets credited what a fast human
 * could have managed and nothing more.
 *
 * The cap is deliberately above what anybody can really do (twenty a second,
 * where a good masher manages twelve or so). It is there to make cheating
 * pointless, not to referee the top end of honest play.
 */
export const BUTTON_MASH_GAME: PartyGame = {
  id: "buttonMash",
  description: "Click as fast as you can!",
  timedSeconds: PARTY.MASH_SECONDS,
  maxSeconds: PARTY.MASH_SECONDS + 2,
  // Five seconds costs everyone the same five seconds; there is nothing to stop.
  stopsProduction: false,

  setup(match, players) {
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) {
      perPlayer[player.id] = { clicks: 0, lastReportTick: match.tick };
    }
    return { shared: {}, perPlayer };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "mash") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me) return { ok: false, error: "Not in this one" };
    if (session.endsTick !== null && match.tick > session.endsTick) {
      return { ok: false, error: "Time" };
    }

    const claimed = typeof action.clicks === "number" ? Math.floor(action.clicks) : 0;
    if (!Number.isFinite(claimed) || claimed <= 0) return { ok: true };

    const since = Math.max(1, match.tick - ((me.data.lastReportTick as number) ?? match.tick));
    const allowance = Math.ceil(
      (since / TICK.RATE) * param("party.mashMaxPerSecond", PARTY.MASH_MAX_PER_SECOND),
    );
    me.data.lastReportTick = match.tick;
    me.data.clicks = ((me.data.clicks as number) ?? 0) + Math.min(claimed, allowance);
    return { ok: true };
  },

  bot(match, session, player) {
    const me = session.players[player.id];
    if (!me) return;
    // A rate rolled once and held: a bot whose speed wandered every tick would
    // average out to the middle of its band every time, and the band is the
    // point — an easy bot should sometimes beat a medium one.
    const rate =
      (me.data.botRate as number | undefined) ??
      between(match.rng, ...MASH_CPS[botDifficulty(match, player.id)]);
    me.data.botRate = rate;
    me.data.clicks = ((me.data.clicks as number) ?? 0) + rate / TICK.RATE;
  },

  result(match, session) {
    const ranked = rankByClicks(match, session);
    if (ranked.length < 2) return null;
    const most = ranked[0]!;
    const least = ranked[ranked.length - 1]!;
    return `${most.label} clicked the most | ${least.label} clicked the least`;
  },
};

/** Everybody still in the match, best to worst. */
function rankByClicks(
  match: Match,
  session: PartySession,
): { id: string; clicks: number; label: string }[] {
  return Object.entries(session.players)
    .map(([id, state]) => {
      const player = match.gameState?.getPlayer(id);
      return {
        id,
        clicks: Math.floor((state.data.clicks as number) ?? 0),
        label: player ? kingdomLabel(player.kingdomId) : "",
      };
    })
    .filter((entry) => entry.label !== "")
    .sort((a, b) => b.clicks - a.clicks);
}

/**
 * Pays the winner and hits the loser, once the five seconds are up.
 *
 * ⚠️ A TIE AT THE TOP OR THE BOTTOM IS NOT A DRAW, IT IS A SHARED RESULT. Two
 * kingdoms on the same count both heal, or both take it. Breaking the tie with
 * a coin would mean the game sometimes punishes a player for something another
 * player did identically.
 */
export function settleButtonMash(match: Match, session: PartySession): void {
  const ranked = rankByClicks(match, session);
  if (ranked.length < 2) return;

  const most = ranked[0]!.clicks;
  const least = ranked[ranked.length - 1]!.clicks;
  // Everybody on zero means nobody played: no winner, no loser, no story.
  if (most === least) return;

  for (const entry of ranked) {
    const player = match.gameState?.getPlayer(entry.id);
    if (!player || player.eliminated) continue;
    const state = session.players[entry.id]!;
    if (entry.clicks === most) {
      healCastle(player, param("party.mashHeal", PARTY.MASH_HEAL));
      state.outcome = "won";
      state.data.result = "most";
    } else if (entry.clicks === least) {
      applyDamage(player, param("party.mashPenalty", PARTY.MASH_PENALTY), { tick: match.tick });
      state.outcome = "lost";
      state.data.result = "least";
    }
    state.done = true;
    state.finishedTick ??= match.tick;
  }
}
