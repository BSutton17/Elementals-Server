import { PARTY } from "../../data/balance.js";
import { applyDamage } from "../combat.js";
import { earn } from "../money.js";
import { param } from "../parameters.js";
import type { Match } from "../../match/Match.js";
import type { PartyActionResult, PartyGame, PartySession, PartySetup } from "./types.js";

/**
 * Keep or steal.
 *
 * Everyone commits in secret, then one resolve:
 *
 *   · all KEEP  → everyone takes a thousand gold
 *   · all STEAL → everyone takes two and a half thousand damage
 *   · mixed     → the thieves take two thousand each, the honest get nothing
 *
 * ⚠️ NOBODY'S CHOICE GOES ON THE WIRE UNTIL EVERYBODY HAS MADE ONE. That is the
 * entire game: it is a bet on what the table will do, and a player who could
 * watch the picks arrive would simply wait and answer them. The sync strips
 * every unresolved choice — see `partySync.ts` — so the only thing anyone can
 * see before the barrier is HOW MANY have decided.
 *
 * ⚠️ AND NOT CHOOSING IS KEEPING. Ten seconds, then the table resolves without
 * you. Defaulting to STEAL would punish a player for looking away by making
 * them the reason everybody took damage; defaulting to KEEP costs them the
 * thief's payout and nothing else, which is the right price for inaction.
 */

export type ThiefChoice = "keep" | "steal";

export const KINGDOM_THIEF_GAME: PartyGame = {
  id: "kingdomThief",
  description:
    "Everyone KEEPS: 1,000 gold each. Everyone STEALS: 2,500 damage each. Mixed: thieves take 2,000, the rest get nothing",
  timedSeconds: PARTY.CHOICE_SECONDS,
  maxSeconds: PARTY.CHOICE_SECONDS + 2,
  // Ten seconds costs the whole table the same ten seconds.
  stopsProduction: false,

  setup(_match, players) {
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) perPlayer[player.id] = { choice: null };
    return { shared: {}, perPlayer };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "choose") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "Already chosen" };

    const choice = action.choice;
    if (choice !== "keep" && choice !== "steal") {
      return { ok: false, error: "Keep or steal" };
    }

    me.data.choice = choice;
    // ⚠️ DONE, BUT NOT SETTLED. Choosing ends this player's turn; what the
    // choice is WORTH depends on what everyone else picked, and that is not
    // known until the barrier. Nothing is paid here.
    me.done = true;
    me.outcome = null;
    me.finishedTick = match.tick;
    return { ok: true };
  },

  bot(match, session, player) {
    const me = session.players[player.id];
    if (!me || me.done) return;

    // A moment's "thought" first, so a table of bots does not resolve the
    // instant it appears and leave a person staring at a finished game.
    if (me.data.botChooseTick === undefined) {
      me.data.botChooseTick =
        session.startedTick + Math.round((1.5 + match.rng() * 4) * 20);
      return;
    }
    if (match.tick < (me.data.botChooseTick as number)) return;

    me.data.choice = botChoice(match, session);
    me.done = true;
    me.finishedTick = match.tick;
  },

  forceFinish(match, session, player) {
    // Not choosing is keeping — see the header for why the default is the
    // generous one and not the greedy one.
    const me = session.players[player.id];
    if (!me) return;
    me.data.choice = "keep";
    me.data.defaulted = true;
    me.done = true;
    me.finishedTick = match.tick;
  },

  result(_match, session) {
    const picks = choices(session);
    if (picks.length === 0) return null;
    if (picks.every((c) => c === "keep")) {
      return `All kingdoms receive ${param("party.thiefKeepReward", PARTY.THIEF_KEEP_REWARD).toLocaleString()} gold`;
    }
    if (picks.every((c) => c === "steal")) {
      return `All kingdoms take ${param("party.thiefAllStealDamage", PARTY.THIEF_ALL_STEAL_DAMAGE).toLocaleString()} damage`;
    }
    return `Those who stole get ${param("party.thiefStealReward", PARTY.THIEF_STEAL_REWARD).toLocaleString()} gold`;
  },
};

/**
 * What the bots do, as a TABLE rather than as individuals.
 *
 * ⚠️ THE GROUP ROLL IS THE POINT, and it ignores difficulty entirely. This is
 * not a game of skill — a "hard" bot has no better read on a stranger's
 * generosity than an easy one. What it does have is a mood: a third of the time
 * the bots all keep, a third they all steal, and a third they each decide for
 * themselves. Rolling every bot independently would make an all-steal table
 * essentially impossible on a big board, and losing everything to a table that
 * ALL stole is the story this game exists to produce.
 */
function botChoice(match: Match, session: PartySession): ThiefChoice {
  const mood = session.shared.botMood as ThiefChoice | "split" | undefined;
  if (mood === undefined) {
    const roll = match.rng();
    session.shared.botMood = roll < 1 / 3 ? "keep" : roll < 2 / 3 ? "steal" : "split";
    return botChoice(match, session);
  }
  if (mood === "split") return match.rng() < 0.5 ? "keep" : "steal";
  return mood;
}

/** Everyone's decision, in seat order. */
function choices(session: PartySession): ThiefChoice[] {
  return Object.values(session.players)
    .map((p) => p.data.choice as ThiefChoice | null)
    .filter((c): c is ThiefChoice => c === "keep" || c === "steal");
}

/** Pays the table out, once every kingdom has committed. */
export function settleKingdomThief(match: Match, session: PartySession): void {
  const state = match.gameState;
  if (!state) return;

  // Anyone who never chose is treated as having kept — see the header.
  for (const player of Object.values(session.players)) {
    if (player.data.choice === null || player.data.choice === undefined) {
      player.data.choice = "keep";
      player.data.defaulted = true;
    }
  }

  const picks = choices(session);
  const allKeep = picks.length > 0 && picks.every((c) => c === "keep");
  const allSteal = picks.length > 0 && picks.every((c) => c === "steal");

  for (const [id, entry] of Object.entries(session.players)) {
    const player = state.getPlayer(id);
    if (!player || player.eliminated) continue;
    const choice = entry.data.choice as ThiefChoice;

    if (allKeep) {
      earn(player, param("party.thiefKeepReward", PARTY.THIEF_KEEP_REWARD));
      entry.outcome = "won";
    } else if (allSteal) {
      applyDamage(player, param("party.thiefAllStealDamage", PARTY.THIEF_ALL_STEAL_DAMAGE), {
        tick: match.tick,
      });
      entry.outcome = "lost";
    } else if (choice === "steal") {
      earn(player, param("party.thiefStealReward", PARTY.THIEF_STEAL_REWARD));
      entry.outcome = "won";
    } else {
      entry.outcome = "lost";
    }
    entry.done = true;
    entry.finishedTick ??= match.tick;
  }
}
