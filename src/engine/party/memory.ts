import { PARTY } from "../../data/balance.js";
import { applyDamage } from "../combat.js";
import { earn } from "../money.js";
import { param } from "../parameters.js";
import { botDifficulty, successChance } from "./bots.js";
import type {
  PartyActionResult,
  PartyGame,
  PartySession,
  PartySetup,
} from "./types.js";

/**
 * Memorize the following symbols.
 *
 * A three-second countdown, eight symbols flashed one after another, then one
 * question about what just went past. Right pays gold; wrong takes a bite out
 * of the castle. Production is stopped until the answer comes in, so there is
 * no waiting it out.
 *
 * ⚠️ THE ANSWER IS DECIDED HERE AND THE QUESTION IS CHOSEN HERE. The sequence
 * has to reach the client — it is the thing the player is asked to watch — so
 * that much is unavoidably visible to anyone reading their own network tab.
 * What is NOT sent is which question is coming: it is drawn at setup and held
 * server-side until the flashing ends, so the sequence cannot be skimmed for
 * "just the third one" while it plays.
 */

/** The ten symbols, by the react-icons component each maps to on the client. */
export const MEMORY_SYMBOLS = [
  "random",
  "accountBook",
  "zeroCircle",
  "abacus",
  "airportSign",
  "abstract",
  "android",
  "activity",
  "adjust",
  "abstract016",
] as const;

export type MemorySymbol = (typeof MEMORY_SYMBOLS)[number];

export type MemoryQuestionKind = "positional" | "repeated" | "followed";

export interface MemoryQuestion {
  kind: MemoryQuestionKind;
  /** 3, 5 or 7 for a positional question — 1-based, as it is asked. */
  position?: number;
  /** The symbol the answer must follow, for a "what came after X" question. */
  after?: MemorySymbol;
  /** The symbol that is correct. Never sent to the client. */
  answer: MemorySymbol;
}

/**
 * Builds a sequence of eight with EXACTLY one symbol appearing twice.
 *
 * The repeat is not incidental — one of the three questions asks for it, so a
 * sequence with no repeat (or two of them) has no answer, or two. Constructing
 * it that way is the only way that question can always be asked.
 */
export function buildSequence(rng: () => number): MemorySymbol[] {
  const pool = [...MEMORY_SYMBOLS];
  // Fisher-Yates, so every symbol is equally likely to be in the seven picked.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const seven = pool.slice(0, 7);
  const doubled = seven[Math.floor(rng() * seven.length)]!;
  const sequence = [...seven, doubled];

  // Shuffle the eight, then make sure the pair is not adjacent: two identical
  // symbols back to back read as one symbol flashing twice, and the player
  // cannot tell whether they saw two or one that stuttered.
  for (let i = sequence.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [sequence[i], sequence[j]] = [sequence[j]!, sequence[i]!];
  }
  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] === sequence[i - 1]) {
      const swapWith = i === sequence.length - 1 ? 0 : sequence.length - 1;
      [sequence[i], sequence[swapWith]] = [sequence[swapWith]!, sequence[i]!];
    }
  }
  return sequence;
}

/** Picks a question the sequence can actually answer. */
export function buildQuestion(sequence: MemorySymbol[], rng: () => number): MemoryQuestion {
  const kinds: MemoryQuestionKind[] = ["positional", "repeated", "followed"];
  const kind = kinds[Math.floor(rng() * kinds.length)]!;

  if (kind === "positional") {
    const position = [3, 5, 7][Math.floor(rng() * 3)]!;
    return { kind, position, answer: sequence[position - 1]! };
  }

  if (kind === "repeated") {
    const seen = new Set<MemorySymbol>();
    for (const symbol of sequence) {
      if (seen.has(symbol)) return { kind, answer: symbol };
      seen.add(symbol);
    }
    // Unreachable with a sequence from `buildSequence`, which always plants a
    // pair — but a question with no answer is not something to find out at
    // runtime, so it falls back rather than trusting that.
    return { kind: "positional", position: 3, answer: sequence[2]! };
  }

  // "What was followed by X" — X is the ANCHOR and the answer is whatever came
  // before it, so X is the symbol that has to be unique. A repeated anchor has
  // two predecessors and therefore two right answers; the repeated symbol being
  // the ANSWER is fine, because that is still one symbol to point at.
  const candidates: number[] = [];
  for (let i = 1; i < sequence.length; i++) {
    const anchor = sequence[i]!;
    const appearsOnce = sequence.filter((s) => s === anchor).length === 1;
    if (appearsOnce) candidates.push(i);
  }
  if (candidates.length === 0) {
    return { kind: "positional", position: 5, answer: sequence[4]! };
  }
  const index = candidates[Math.floor(rng() * candidates.length)]!;
  return { kind: "followed", after: sequence[index]!, answer: sequence[index - 1]! };
}

export const MEMORY_GAME: PartyGame = {
  id: "memory",
  description: "Memorize the following symbols",
  timedSeconds: null, // blocking: it ends when the table has answered
  maxSeconds: PARTY.MEMORY_MAX_SECONDS,
  stopsProduction: true,

  setup(match, players) {
    const sequence = buildSequence(match.rng);
    const question = buildQuestion(sequence, match.rng);
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) perPlayer[player.id] = {};
    return {
      shared: {
        sequence,
        // Held back until the flashing is over — see the header.
        question: question as unknown as Record<string, unknown>,
        countdownSeconds: param("party.memoryCountdown", PARTY.MEMORY_COUNTDOWN_SECONDS),
        flashMs: param("party.memoryFlashMs", PARTY.MEMORY_FLASH_MS),
      },
      perPlayer,
    };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "answer") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "Already answered" };

    const guess = typeof action.symbol === "string" ? action.symbol : "";
    if (!MEMORY_SYMBOLS.includes(guess as MemorySymbol)) {
      return { ok: false, error: "Not one of the symbols" };
    }

    const question = session.shared.question as unknown as MemoryQuestion;
    const correct = guess === question.answer;

    me.done = true;
    me.outcome = correct ? "won" : "lost";
    me.finishedTick = match.tick;
    me.data.guess = guess;
    // The answer goes into THEIR record once they have answered, so the popup
    // can show what it was without handing it to anyone still thinking.
    me.data.correctAnswer = question.answer;

    if (correct) {
      earn(player, param("party.memoryReward", PARTY.MEMORY_REWARD));
    } else {
      applyDamage(player, param("party.memoryPenalty", PARTY.MEMORY_PENALTY), {
        tick: match.tick,
      });
    }
    return { ok: true };
  },

  bot(match, session, player) {
    const me = session.players[player.id];
    if (!me || me.done) return;

    const question = session.shared.question as unknown as MemoryQuestion;
    const readyAt =
      session.startedTick +
      Math.round(
        (param("party.memoryCountdown", PARTY.MEMORY_COUNTDOWN_SECONDS) +
          (8 * param("party.memoryFlashMs", PARTY.MEMORY_FLASH_MS)) / 1000 +
          1 +
          match.rng() * 3) *
          20,
      );
    if (match.tick < readyAt) return;

    const right = match.rng() < successChance(botDifficulty(match, player.id));
    const wrong = MEMORY_SYMBOLS.filter((s) => s !== question.answer);
    const guess = right ? question.answer : wrong[Math.floor(match.rng() * wrong.length)]!;

    me.done = true;
    me.outcome = right ? "won" : "lost";
    me.finishedTick = match.tick;
    me.data.guess = guess;
    me.data.correctAnswer = question.answer;
    if (right) {
      earn(player, param("party.memoryReward", PARTY.MEMORY_REWARD));
    } else {
      applyDamage(player, param("party.memoryPenalty", PARTY.MEMORY_PENALTY), {
        tick: match.tick,
      });
    }
  },

  result() {
    return null; // "none"
  },
};

/** The question, for the debug launcher and tests. */
export function questionOf(session: PartySession): MemoryQuestion {
  return session.shared.question as unknown as MemoryQuestion;
}
