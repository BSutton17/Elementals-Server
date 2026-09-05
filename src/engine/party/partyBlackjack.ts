import { PARTY, TICK } from "../../data/balance.js";
import { earn, getBalance, roundMoney } from "../money.js";
import { param } from "../parameters.js";
import type { PlayerState } from "../../match/playerState.js";
import type { Match } from "../../match/Match.js";
import type {
  PartyAction,
  PartyActionResult,
  PartyGame,
  PartySession,
  PartySetup,
} from "./types.js";

/**
 * May the odds be ever in your favour.
 *
 * One hand of blackjack with every coin you own on the table. Splitting and
 * doubling are allowed — including re-splitting, and doubling a split hand —
 * which is where the interesting problem is.
 *
 * ⚠️ NOBODY GOES INTO DEBT, AND NOBODY IS STOPPED FROM SPLITTING EITHER. The
 * whole appeal of the ultimatum is being allowed to reach past what you can
 * cover; the engine's money, meanwhile, floors at zero and a negative balance
 * would break every price check downstream. So a loss that runs past the purse
 * is not deducted — it is OWED, and the debt is paid in PRODUCTION: income is
 * frozen until the gold that would have been earned adds up to what was owed.
 * A gambler who overreaches loses their economy for a while instead of holding
 * a negative number nothing else in the game knows how to read.
 *
 * ⚠️ THE DEALER'S HOLE CARD NEVER GOES ON THE WIRE UNTIL IT IS TURNED. Every
 * other secret in this mode is one the player is meant to see anyway; this one
 * is the entire game. `sanitizeForWire` strips it, and the shoe is dealt
 * server-side so there is nothing else to read ahead.
 *
 * Not to be confused with `engine/blackjack.ts`, which is Joker's ability — a
 * single card drawn as a weapon. This is a hand of cards played for money.
 */

export type Suit = "clubs" | "diamonds" | "hearts" | "spades";
export interface Card {
  /** 1 = ace, 11-13 = jack/queen/king. */
  rank: number;
  suit: Suit;
}

export interface Hand {
  cards: Card[];
  bet: number;
  /** Set once the hand can take no more cards. */
  standing: boolean;
  doubled: boolean;
  /** True for a hand made by splitting, which caps what it may do. */
  fromSplit: boolean;
  outcome: "win" | "lose" | "push" | "blackjack" | null;
}

export interface BlackjackState {
  hands: Hand[];
  /** Which hand the player is acting on. */
  active: number;
  dealerUp: Card | null;
  /** Face down until the player stands out. Stripped on the way to the client. */
  dealerHole: Card | null;
  dealerCards: Card[];
  /** The gold at risk when the hand began — what "all your gold" meant. */
  stake: number;
  /** Gold that could not be paid, worked off against production. */
  owed: number;
  /** Set when the hand is over. */
  settled: boolean;
  net: number;
  /**
   * The tick the table clears on, once the dealer has turned over.
   *
   * ⚠️ SETTLING AND FINISHING ARE DIFFERENT MOMENTS, AND USED NOT TO BE.
   * Standing resolved the round and marked the player done in the same breath,
   * so the panel came down before the dealer's cards had been on screen for a
   * single frame: the player saw their own hand, pressed stand, and was
   * returned to the battlefield already poorer. The money is settled at the
   * first moment; this is the second.
   */
  revealUntilTick: number | null;
}

const SUITS: Suit[] = ["clubs", "diamonds", "hearts", "spades"];

function drawCard(rng: () => number): Card {
  // An infinite shoe: cards are drawn independently rather than from a dealt
  // deck. With one hand per player and no card counting worth doing in six
  // seconds, a real shoe would only add state to synchronise.
  return {
    rank: 1 + Math.floor(rng() * 13),
    suit: SUITS[Math.floor(rng() * SUITS.length)]!,
  };
}

/** Blackjack scoring: face cards are ten, an ace is eleven until that busts. */
export function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === 1) {
      aces += 1;
      total += 11;
    } else {
      total += Math.min(10, card.rank);
    }
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
    soft = aces > 0;
  }
  return { total, soft };
}

export function isBlackjack(hand: Hand): boolean {
  return !hand.fromSplit && hand.cards.length === 2 && handValue(hand.cards).total === 21;
}

function canSplit(state: BlackjackState, hand: Hand): boolean {
  if (hand.cards.length !== 2 || hand.doubled) return false;
  const [a, b] = hand.cards as [Card, Card];
  // Value pairs, not rank pairs: a king and a queen are both ten, and every
  // casino lets you split them.
  const value = (card: Card) => (card.rank === 1 ? 1 : Math.min(10, card.rank));
  if (value(a) !== value(b)) return false;
  return state.hands.length < param("party.blackjackMaxHands", PARTY.BLACKJACK_MAX_HANDS);
}

/** Deals the opening hand. */
export function openHand(player: PlayerState, rng: () => number): BlackjackState {
  const stake = Math.max(
    param("party.blackjackMinStake", PARTY.BLACKJACK_MIN_STAKE),
    Math.floor(getBalance(player)),
  );
  const hand: Hand = {
    cards: [drawCard(rng), drawCard(rng)],
    bet: stake,
    standing: false,
    doubled: false,
    fromSplit: false,
    outcome: null,
  };
  return {
    hands: [hand],
    active: 0,
    dealerUp: drawCard(rng),
    dealerHole: drawCard(rng),
    dealerCards: [],
    stake,
    owed: 0,
    settled: false,
    revealUntilTick: null,
    net: 0,
  };
}

/** Moves to the next hand that still needs playing, or resolves the round. */
function advance(state: BlackjackState, rng: () => number): void {
  for (let i = 0; i < state.hands.length; i++) {
    const hand = state.hands[i]!;
    if (!hand.standing && handValue(hand.cards).total <= 21) {
      state.active = i;
      return;
    }
  }
  resolveRound(state, rng);
}

/** Plays the dealer out and scores every hand. */
export function resolveRound(state: BlackjackState, rng: () => number): void {
  if (state.settled) return;
  state.dealerCards = [state.dealerUp!, state.dealerHole!];

  const anyLive = state.hands.some((h) => handValue(h.cards).total <= 21);
  if (anyLive) {
    // The dealer stands on all seventeens, soft included. One rule, stated
    // once, so the table never has to wonder which house they are playing.
    while (handValue(state.dealerCards).total < 17) {
      state.dealerCards.push(drawCard(rng));
    }
  }

  const dealer = handValue(state.dealerCards).total;
  const dealerBlackjack = state.dealerCards.length === 2 && dealer === 21;

  let net = 0;
  for (const hand of state.hands) {
    const total = handValue(hand.cards).total;
    if (total > 21) {
      hand.outcome = "lose";
      net -= hand.bet;
      continue;
    }
    if (isBlackjack(hand) && !dealerBlackjack) {
      hand.outcome = "blackjack";
      // Three to two, the way it is meant to be paid.
      net += Math.round(hand.bet * 1.5);
      continue;
    }
    if (!anyLive || dealer > 21 || total > dealer) {
      hand.outcome = "win";
      net += hand.bet;
      continue;
    }
    if (total === dealer) {
      hand.outcome = "push";
      continue;
    }
    hand.outcome = "lose";
    net -= hand.bet;
  }

  state.net = net;
  state.settled = true;
}

/**
 * Applies the round's result to the player's purse.
 *
 * A win is paid. A loss is taken out of the purse as far as it goes, and
 * whatever is left over becomes `owed` — production debt, not negative gold.
 */
export function settleMoney(player: PlayerState, state: BlackjackState): void {
  if (state.net >= 0) {
    earn(player, state.net);
    return;
  }
  const loss = -state.net;
  const purse = getBalance(player);
  const paid = Math.min(purse, loss);
  player.economy.currency = roundMoney(purse - paid);
  const owed = loss - paid;
  if (owed > 0) {
    state.owed = owed;
    // Read by `applyPassiveIncome`, which withholds income until it is worked
    // off. Held on the PLAYER rather than the session because the session ends
    // long before a big debt does.
    player.economy.productionDebt = roundMoney(
      (player.economy.productionDebt ?? 0) + owed,
    );
  }
}

export const BLACKJACK_GAME: PartyGame = {
  id: "blackjack",
  description: "May the odds be ever in your favor",
  timedSeconds: null,
  maxSeconds: PARTY.BLACKJACK_MAX_SECONDS,
  stopsProduction: true,

  setup(match, players) {
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) {
      perPlayer[player.id] = {
        game: openHand(player, match.rng) as unknown as Record<string, unknown>,
      };
    }
    return { shared: {}, perPlayer };
  },

  act(match, session, player, action): PartyActionResult {
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "Already finished" };
    const state = me.data.game as unknown as BlackjackState;
    if (state.settled) return { ok: false, error: "The hand is over" };

    const hand = state.hands[state.active];
    if (!hand) return { ok: false, error: "No hand to play" };

    switch (action.type) {
      case "hit": {
        hand.cards.push(drawCard(match.rng));
        if (handValue(hand.cards).total >= 21) {
          hand.standing = true;
          advance(state, match.rng);
        }
        break;
      }
      case "stand": {
        hand.standing = true;
        advance(state, match.rng);
        break;
      }
      case "double": {
        if (hand.cards.length !== 2 || hand.doubled) {
          return { ok: false, error: "Cannot double now" };
        }
        // ⚠️ NOT GATED ON WHAT THEY CAN AFFORD. Doubling past the purse is the
        // point; what it risks is production, not a negative balance.
        hand.bet *= 2;
        hand.doubled = true;
        hand.cards.push(drawCard(match.rng));
        hand.standing = true;
        advance(state, match.rng);
        break;
      }
      case "split": {
        if (!canSplit(state, hand)) return { ok: false, error: "Cannot split that" };
        const moved = hand.cards.pop()!;
        hand.cards.push(drawCard(match.rng));
        const second: Hand = {
          cards: [moved, drawCard(match.rng)],
          bet: hand.bet,
          standing: false,
          doubled: false,
          fromSplit: true,
          outcome: null,
        };
        hand.fromSplit = true;
        state.hands.splice(state.active + 1, 0, second);
        break;
      }
      default:
        return { ok: false, error: "Unknown action" };
    }

    // Settled, but not finished: the dealer's cards go up and stay up for a
    // moment. `tick` closes it.
    if (state.settled && state.revealUntilTick === null) {
      state.revealUntilTick =
        match.tick +
        Math.round(
          param("party.blackjackReveal", PARTY.BLACKJACK_REVEAL_SECONDS) * TICK.RATE,
        );
    }
    return { ok: true };
  },

  tick(match, session, player) {
    // The only thing this does is end the reveal. An abandoned hand is ended by
    // the session's cap, and `forceFinish` settles that one.
    const me = session.players[player.id];
    if (!me || me.done) return;
    const state = me.data.game as unknown as BlackjackState | undefined;
    if (!state?.settled || state.revealUntilTick === null) return;
    if (match.tick < state.revealUntilTick) return;
    finish(match, session, player, state);
  },

  bot(match, session, player) {
    const me = session.players[player.id];
    if (!me || me.done) return;
    const state = me.data.game as unknown as BlackjackState;

    const nextAt = (me.data.botNextTick as number | undefined) ?? null;
    if (nextAt === null) {
      me.data.botNextTick = match.tick + Math.round((1 + match.rng() * 2) * 20);
      return;
    }
    if (match.tick < nextAt) return;
    me.data.botNextTick = match.tick + Math.round((0.6 + match.rng()) * 20);

    const hand = state.hands[state.active];
    if (!hand || state.settled) return;
    BLACKJACK_GAME.act(match, session, player, {
      type: bookMove(hand, state.dealerUp, canSplit(state, hand)),
    } as PartyAction);
  },

  result() {
    return null; // the popup already told them what happened
  },

  forceFinish(match, session, player) {
    // Cards are still on the table and the bet was placed the moment the hand
    // was dealt. Standing the live hands and paying it out is fairer than
    // voiding it: the player chose to sit there.
    forceFinishBlackjack(match, session, player);
  },

  sanitizeForWire(data) {
    const state = data.game as unknown as BlackjackState | undefined;
    if (!state) return data;
    return {
      ...data,
      game: {
        ...state,
        // The hole card is the whole game. It goes on the wire only once the
        // dealer has turned it over.
        dealerHole: state.settled ? state.dealerHole : null,
      } as unknown as Record<string, unknown>,
    };
  },
};

/**
 * Basic strategy — "the book".
 *
 * ⚠️ THE SAME BOOK EVERY CASINO PRINTS ON A CARD, and deliberately not a
 * cleverer one. Card counting is impossible here (the shoe is infinite), so
 * basic strategy IS optimal play, and a bot playing it is a bot playing
 * correctly rather than a bot playing well. Difficulty does not enter into it:
 * the spec asks for bots that play by the book, and half-remembering the book
 * would make a "hard" bot the one that loses money.
 *
 * Ordered the way the card is read: pairs first, then soft hands, then hard.
 */
export function bookMove(
  hand: Hand,
  dealerUp: Card | null,
  splitAllowed: boolean,
): "hit" | "stand" | "double" | "split" {
  const up = dealerUp ? (dealerUp.rank === 1 ? 11 : Math.min(10, dealerUp.rank)) : 10;
  const { total, soft } = handValue(hand.cards);
  const fresh = hand.cards.length === 2 && !hand.doubled;

  // --- pairs ---------------------------------------------------------------
  if (splitAllowed && hand.cards.length === 2) {
    const value = (card: Card) => (card.rank === 1 ? 11 : Math.min(10, card.rank));
    const pair = value(hand.cards[0]!);
    // Aces and eights always; tens and fives never; the rest by the dealer.
    if (pair === 11 || pair === 8) return "split";
    if (pair === 9) return up === 7 || up >= 10 ? "stand" : "split";
    if (pair === 7) return up <= 7 ? "split" : "hit";
    if (pair === 6) return up <= 6 ? "split" : "hit";
    if (pair === 4) return up === 5 || up === 6 ? "split" : "hit";
    if (pair === 3 || pair === 2) return up <= 7 ? "split" : "hit";
    // Fives are a hard ten, tens are twenty: both fall through to the tables.
  }

  // --- soft totals (an ace still counted as eleven) ------------------------
  if (soft) {
    if (total >= 19) return "stand";
    if (total === 18) {
      if (fresh && up >= 3 && up <= 6) return "double";
      return up <= 8 ? "stand" : "hit";
    }
    if (total === 17) return fresh && up >= 3 && up <= 6 ? "double" : "hit";
    if (total >= 15) return fresh && up >= 4 && up <= 6 ? "double" : "hit";
    if (total >= 13) return fresh && up >= 5 && up <= 6 ? "double" : "hit";
    return "hit";
  }

  // --- hard totals ---------------------------------------------------------
  if (total >= 17) return "stand";
  if (total >= 13) return up <= 6 ? "stand" : "hit";
  if (total === 12) return up >= 4 && up <= 6 ? "stand" : "hit";
  if (total === 11) return fresh ? "double" : "hit";
  if (total === 10) return fresh && up <= 9 ? "double" : "hit";
  if (total === 9) return fresh && up >= 3 && up <= 6 ? "double" : "hit";
  return "hit";
}

function finish(
  match: Match,
  session: PartySession,
  player: PlayerState,
  state: BlackjackState,
): void {
  const me = session.players[player.id]!;
  settleMoney(player, state);
  me.done = true;
  me.outcome = state.net >= 0 ? "won" : "lost";
  me.finishedTick = match.tick;
}

/**
 * Settles a hand nobody finished — the session's cap ran out with cards still
 * on the table. Standing the live hands and paying it out is fairer than
 * voiding it: the player chose to sit there, and the bet was already placed.
 */
export function forceFinishBlackjack(
  match: Match,
  session: PartySession,
  player: PlayerState,
): void {
  const me = session.players[player.id];
  if (!me || me.done) return;
  const state = me.data.game as unknown as BlackjackState | undefined;
  if (!state) return;
  for (const hand of state.hands) hand.standing = true;
  resolveRound(state, match.rng);
  finish(match, session, player, state);
}
