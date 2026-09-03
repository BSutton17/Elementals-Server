import { PARTY, TICK } from "../../data/balance.js";
import { applyDamage } from "../combat.js";
import { param } from "../parameters.js";
import { labelFor, rankedLast } from "./results.js";
import { botDifficulty, RETRY_SECONDS, successChance, ticksBetween } from "./bots.js";
import type { Match } from "../../match/Match.js";
import type { PartyActionResult, PartyGame, PartySession, PartySetup } from "./types.js";

/**
 * Answer as quick as you can.
 *
 * One sum. Two shapes only — `a + b` and `a - b`, with the subtraction always
 * arranged so the answer is not negative. Wrong answers cost nothing but time:
 * the box shakes, says "Try again", and the player keeps going. Last kingdom to
 * get it right takes the hit.
 *
 * ⚠️ THE ANSWER NEVER GOES ON THE WIRE. The two operands do — they have to be
 * displayed — but the result is computed here and compared here. Sending it and
 * asking the client to mark its own work would make this the easiest minigame
 * in the game to win.
 *
 * ⚠️ AND A WRONG ANSWER IS NOT A FINISH. It is refused, the attempt is counted,
 * and the player stays in. Ending their turn on a typo would make the punishment
 * fall on whoever fat-fingered a number rather than whoever was slowest, which
 * is not the game.
 */

export interface MathQuestion {
  left: number;
  right: number;
  op: "+" | "-";
  /** Never sent to the client. */
  answer: number;
}

export function buildQuestion(rng: () => number): MathQuestion {
  const a = Math.floor(rng() * 51);
  const b = Math.floor(rng() * 51);
  if (rng() < 0.5) return { left: a, right: b, op: "+", answer: a + b };
  // Subtraction is ordered so the first number is the larger one: a negative
  // answer is a different (and much harder) question, and the spec asks for
  // this one.
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  return { left: high, right: low, op: "-", answer: high - low };
}

export const QUICK_MATH_GAME: PartyGame = {
  id: "quickMath",
  description: "Answer as quick as you can",
  timedSeconds: null,
  maxSeconds: PARTY.QUICK_MATH_MAX_SECONDS,
  stopsProduction: true,

  setup(match, players) {
    const question = buildQuestion(match.rng);
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) perPlayer[player.id] = { attempts: 0 };
    return {
      shared: {
        left: question.left,
        right: question.right,
        op: question.op,
        // Held here, stripped on the way out — see `partySync.ts`.
        answer: question.answer,
      },
      perPlayer,
    };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "answer") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "Already answered" };

    const guess = typeof action.value === "number" ? action.value : NaN;
    if (!Number.isFinite(guess)) return { ok: false, error: "Not a number" };

    me.data.attempts = ((me.data.attempts as number) ?? 0) + 1;
    if (Math.round(guess) !== (session.shared.answer as number)) {
      // Refused, not finished: the box shakes and they try again.
      return { ok: false, error: "Try again" };
    }

    me.done = true;
    me.outcome = "won";
    me.finishedTick = match.tick;
    return { ok: true };
  },

  bot(match, session, player) {
    const me = session.players[player.id];
    if (!me || me.done) return;
    // Rolled on a cadence rather than once: a player who gets the sum wrong
    // tries again, and a bot that failed one roll and then sat there would be
    // guaranteed last place rather than merely slow.
    if (me.data.botAnswerTick === undefined) {
      me.data.botAnswerTick =
        session.startedTick + ticksBetween(match.rng, ...RETRY_SECONDS.math);
      return;
    }
    if (match.tick < (me.data.botAnswerTick as number)) return;
    me.data.botAnswerTick = match.tick + ticksBetween(match.rng, ...RETRY_SECONDS.math);
    me.data.attempts = ((me.data.attempts as number) ?? 0) + 1;

    if (match.rng() >= successChance(botDifficulty(match, player.id))) return;
    me.done = true;
    me.outcome = "won";
    me.finishedTick = match.tick;
  },

  result(match, session) {
    const lastId = rankedLast(session, (p) => p.outcome === "won");
    const label = labelFor(match, lastId);
    return label === null ? null : `${label} was the last one to answer correctly`;
  },
};

/** The hit for coming last, applied once the table is ranked. */
export function settleQuickMath(match: Match, session: PartySession): void {
  const lastId = rankedLast(session, (p) => p.outcome === "won");
  if (!lastId) return;
  const loser = match.gameState?.getPlayer(lastId);
  if (!loser || loser.eliminated) return;
  applyDamage(loser, param("party.quickMathPenalty", PARTY.QUICK_MATH_PENALTY), {
    tick: match.tick,
  });
  session.players[lastId]!.data.punished = true;
}
