import type { PlayerState } from "../match/playerState.js";

/**
 * Joker's Blackjack deck (`data/jokerAbilities.ts`). A real 54-card deck —
 * four each of Ace through King, plus two jokers — drawn from uniformly, so the
 * odds are the deck's own rather than a hand-tuned damage table.
 *
 * Pure and deterministic given an RNG, so a match's seeded generator replays
 * identical draws (#203).
 */

/** Damage per pip on a number card. Face cards and jokers are flat, below. */
export const DAMAGE_PER_RANK = 75;

/** Flat damage for a face card (Jack, Queen, King), whatever its suit. */
export const FACE_CARD_DAMAGE = 750;

/** Flat damage for one of the deck's two jokers — the best draw in the deck. */
export const JOKER_CARD_DAMAGE = 1000;

/**
 * The Ace's rank for damage purposes: a 1, making it the deck's WORST draw at
 * 75. Ace of Spades deliberately does not strip it — it would be stripping
 * itself — so the floor stays low however the deck is stacked.
 */
export const ACE_RANK = 1;

/** Ranks that are FACE cards rather than numbered ones. */
export const FACE_RANKS = [11, 12, 13] as const;

/** How many of each rank a standard deck holds (one per suit). */
const COPIES_PER_RANK = 4;

/** Jokers in the deck. */
const JOKER_COUNT = 2;

/** A single drawn card. `rank` is null for a joker, which has no rank. */
export interface DrawnCard {
  /** 1–13 for Ace–King (Ace draws as `ACE_RANK` damage), null for a joker. */
  rank: number | null;
  /** Human-readable label for events/UI ("7", "Queen", "Joker"). */
  label: string;
  /** Damage this card deals. */
  damage: number;
}

const RANK_LABELS: Record<number, string> = {
  1: "Ace",
  11: "Jack",
  12: "Queen",
  13: "King",
};

const labelFor = (rank: number): string => RANK_LABELS[rank] ?? String(rank);

/** Damage a given rank deals: face cards flat, everything else per-pip. */
export function damageForRank(rank: number): number {
  if ((FACE_RANKS as readonly number[]).includes(rank)) return FACE_CARD_DAMAGE;
  const pips = rank === 1 ? ACE_RANK : rank;
  return pips * DAMAGE_PER_RANK;
}

/**
 * The ranks currently missing from a player's deck (Joker's Ace of Spades
 * strips the 2s and 3s for a few seconds, raising the floor on the next draw).
 */
export function strippedRanks(player: PlayerState): readonly number[] {
  const out = new Set<number>();
  for (const s of player.statuses) {
    for (const rank of s.strippedCardRanks ?? []) out.add(rank);
  }
  return [...out];
}

/**
 * Builds `player`'s current deck as a flat list of draws, honouring whatever
 * their statuses have stripped out. Jokers are never strippable.
 */
export function buildDeck(player: PlayerState): DrawnCard[] {
  const missing = strippedRanks(player);
  const deck: DrawnCard[] = [];
  for (let rank = 1; rank <= 13; rank++) {
    if (missing.includes(rank)) continue;
    for (let i = 0; i < COPIES_PER_RANK; i++) {
      deck.push({ rank, label: labelFor(rank), damage: damageForRank(rank) });
    }
  }
  for (let i = 0; i < JOKER_COUNT; i++) {
    deck.push({ rank: null, label: "Joker", damage: JOKER_CARD_DAMAGE });
  }
  return deck;
}

/**
 * Draws one card uniformly from `player`'s current deck. Every copy is its own
 * entry, so stripping the 2s and 3s genuinely shifts the odds rather than just
 * re-rolling a lookup.
 */
export function drawBlackjackCard(
  player: PlayerState,
  rng: () => number,
): DrawnCard {
  const deck = buildDeck(player);
  // A deck can never be emptied by the strip effects that exist, but a future
  // one could; falling back to a joker keeps the draw total.
  if (deck.length === 0) {
    return { rank: null, label: "Joker", damage: JOKER_CARD_DAMAGE };
  }
  const index = Math.min(deck.length - 1, Math.floor(rng() * deck.length));
  return deck[index]!;
}
