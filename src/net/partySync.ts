import { PARTY, TICK } from "../data/balance.js";
import { param } from "../engine/parameters.js";
import { partyGame } from "../engine/party/index.js";
import type { PartySession } from "../engine/party/types.js";
import type { Match } from "../match/Match.js";

/**
 * The minigame, shaped for the wire.
 *
 * ⚠️ TWO THINGS ARE HELD BACK, AND ONLY TWO. Everything else a minigame knows
 * is something the player is meant to be looking at, so hiding it would be
 * theatre — the maze has to be drawn, the symbols have to flash, both castles
 * have to be rendered. What genuinely must not travel early is:
 *
 *   · Blackjack's hole card, which is the entire game (`sanitizeForWire`), and
 *   · Memory's question, which is drawn at setup but must not be readable while
 *     the symbols are still flashing — otherwise "what was the fifth?" can be
 *     answered by watching only the fifth.
 *
 * The memory ANSWER never goes out at all. The client submits a guess and this
 * side judges it.
 */
export interface PartyWire {
  gameId: string;
  description: string;
  /** Ticks since it started, so the client can drive its own animations. */
  elapsedTicks: number;
  /** Ticks until a timed game ends, or null for a blocking one. */
  ticksRemaining: number | null;
  shared: Record<string, unknown>;
  players: Record<
    string,
    { done: boolean; outcome: string | null; finishedTick: number | null; data: Record<string, unknown> }
  >;
  /** Null until somebody finishes — while it is null, attacks are held. */
  firstFinisherId: string | null;
  finishOrder: string[];
  /** Set once it is over; the result banner shows for `RESULT_SECONDS`. */
  resolved: boolean;
  resultText: string | null;
}

export function partyForWire(match: Match, session: PartySession): PartyWire {
  const game = partyGame(session.gameId);
  const shared = { ...session.shared };

  if (session.gameId === "memory") {
    const countdown = param("party.memoryCountdown", PARTY.MEMORY_COUNTDOWN_SECONDS);
    const flashMs = param("party.memoryFlashMs", PARTY.MEMORY_FLASH_MS);
    const revealAt =
      session.startedTick + Math.round((countdown + (8 * flashMs) / 1000) * TICK.RATE);
    const question = session.shared.question as
      | { kind: string; position?: number; after?: string }
      | undefined;
    shared.question =
      match.tick >= revealAt && question
        ? // The answer is stripped even here: the client is asked the question,
          // never told what closes it.
          { kind: question.kind, position: question.position, after: question.after }
        : null;
  }

  if (session.gameId === "quickMath") {
    // The operands are the question and have to be shown; the result is the
    // answer and never leaves this side.
    delete shared.answer;
  }

  if (session.gameId === "reaction") {
    // ⚠️ THE MOMENT, NOT THE DEADLINE. Sending `greenAtTick` would hand every
    // client the exact tick to click on — a five-line script would win this
    // every time, and it hands out damage. What goes out is a boolean that
    // flips when the server says so, which is also what makes the race fair:
    // everybody learns on the same broadcast.
    delete shared.greenAtTick;
    shared.green = match.tick >= (session.shared.greenAtTick as number);
  }

  const revealChoices = session.resolvedTick !== null;

  const players: PartyWire["players"] = {};
  for (const [id, state] of Object.entries(session.players)) {
    let data = game?.sanitizeForWire ? game.sanitizeForWire(state.data) : state.data;

    if (session.gameId === "kingdomThief" && !revealChoices) {
      // ⚠️ THE WHOLE GAME IS THE SECRET. Kingdom Thief is a bet on what the
      // table will do; a player who could watch the picks land would simply
      // wait and answer them, and everybody would learn to wait. What travels
      // before the barrier is only WHETHER somebody has decided.
      data = { ...data, choice: null };
    }

    players[id] = {
      done: state.done,
      outcome: state.outcome,
      finishedTick: state.finishedTick,
      data,
    };
  }

  return {
    gameId: session.gameId,
    description: game?.description ?? "",
    elapsedTicks: match.tick - session.startedTick,
    ticksRemaining:
      session.endsTick === null ? null : Math.max(0, session.endsTick - match.tick),
    shared,
    players,
    firstFinisherId: session.firstFinisherId,
    finishOrder: session.finishOrder,
    resolved: session.resolvedTick !== null,
    resultText: session.resultText,
  };
}
