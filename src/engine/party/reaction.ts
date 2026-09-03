import { PARTY, TICK } from "../../data/balance.js";
import { applyDamage } from "../combat.js";
import { param } from "../parameters.js";
import { labelFor, rankedLast } from "./results.js";
import { botDifficulty, REACTION_MS, ticksBetweenMs } from "./bots.js";
import type { PartyActionResult, PartyGame, PartySetup } from "./types.js";

/**
 * Click when the button turns green.
 *
 * A red button that does nothing, for somewhere between two and six seconds.
 * Then it turns green. Click before it does and the castle takes a hit; be the
 * last kingdom to click and it takes the same hit.
 *
 * ⚠️ THE GREEN MOMENT IS A TICK ON THIS SIDE, NOT A TIMER ON THAT ONE. The
 * server decides when the button turns and stamps every click with the tick it
 * arrived on. If the client owned the clock, "I clicked at 0.19s" would be a
 * number the winner types in — and this game hands out damage.
 *
 * ⚠️ AND THERE IS NO WAY OUT BUT THROUGH. Production is stopped until a player
 * clicks, so waiting is not a strategy: a kingdom that refuses to play stands
 * there earning nothing and is still last when the session times out.
 */
/** Everyone who did not click before the light. */
const notJumped = (state: { data: Record<string, unknown> }) => state.data.jumped !== true;

export const REACTION_GAME: PartyGame = {
  id: "reaction",
  description: "Click when the button turns green",
  timedSeconds: null,
  maxSeconds: PARTY.REACTION_MAX_SECONDS,
  stopsProduction: true,

  setup(match, players) {
    const min = param("party.reactionMinDelay", PARTY.REACTION_MIN_DELAY_SECONDS);
    const max = param("party.reactionMaxDelay", PARTY.REACTION_MAX_DELAY_SECONDS);
    // ONE moment for the whole table. Staggering it per player would make the
    // race meaningless — everybody would be reacting to a different starting
    // gun and "last to click" would be an accident of who drew the short wait.
    const wait = min + match.rng() * (max - min);
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) perPlayer[player.id] = {};
    return {
      shared: { greenAtTick: match.tick + Math.round(wait * TICK.RATE) },
      perPlayer,
    };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "click") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "Already clicked" };

    const greenAt = session.shared.greenAtTick as number;
    if (match.tick < greenAt) {
      // Too early. Out of the race, and it costs.
      me.done = true;
      me.outcome = "lost";
      me.finishedTick = match.tick;
      me.data.jumped = true;
      applyDamage(player, param("party.reactionPenalty", PARTY.REACTION_PENALTY), {
        tick: match.tick,
      });
      return { ok: true };
    }

    me.done = true;
    me.outcome = "won";
    me.finishedTick = match.tick;
    // Reported back so the player sees their own time; it is derived from the
    // server's ticks, not measured on their machine.
    me.data.reactionTicks = match.tick - greenAt;
    return { ok: true };
  },

  bot(match, session, player) {
    const me = session.players[player.id];
    if (!me || me.done) return;
    const greenAt = session.shared.greenAtTick as number;

    if (me.data.botClickTick === undefined) {
      // ⚠️ MEASURED FROM THE LIGHT, NOT FROM THE START. Scheduling off the
      // session's start would have a bot clicking before the button turned —
      // which the server would score as jumping the gun, and every bot would
      // lose every reaction test by construction.
      const [low, high] = REACTION_MS[botDifficulty(match, player.id)];
      me.data.botClickTick = greenAt + ticksBetweenMs(match.rng, low, high);
      return;
    }
    if (match.tick < (me.data.botClickTick as number)) return;

    me.done = true;
    me.outcome = "won";
    me.finishedTick = match.tick;
    me.data.reactionTicks = match.tick - greenAt;
  },

  result(match, session) {
    const lastId = rankedLast(session, (p) => p.outcome === "won", notJumped);
    const label = labelFor(match, lastId);
    return label === null ? null : `${label} was the last one to react`;
  },
};

/**
 * Punishes whoever came last, once the whole table has been ranked.
 *
 * Called at resolve rather than on the last click, because "last" is not known
 * until the session closes — a player who never clicks at all is later than
 * every player who did.
 */
export function settleReaction(
  match: import("../../match/Match.js").Match,
  session: import("./types.js").PartySession,
): void {
  // Jumpers are excluded from the ranking rather than ranked last: they have
  // already paid, and treating them as last would let the genuinely slowest
  // kingdom walk while the jumper is hit twice for one mistake.
  const lastId = rankedLast(session, (p) => p.outcome === "won", notJumped);
  if (!lastId) return;
  const loser = match.gameState?.getPlayer(lastId);
  if (!loser || loser.eliminated) return;
  applyDamage(loser, param("party.reactionPenalty", PARTY.REACTION_PENALTY), {
    tick: match.tick,
  });
  session.players[lastId]!.data.punished = true;
}
