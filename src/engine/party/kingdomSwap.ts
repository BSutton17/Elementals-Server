import { PARTY, TICK } from "../../data/balance.js";
import { param } from "../parameters.js";
import { kingdomLabel } from "./results.js";
import { abilitiesForKingdom } from "../../data/kingdomAbilities.js";
import type { KingdomId } from "../../data/kingdoms.js";
import type { Match } from "../../match/Match.js";
import type { PartyGame, PartySetup } from "./types.js";

/**
 * You have someone else's abilities for thirty seconds.
 *
 * Pairs of kingdoms trade KITS. Nothing else moves: health, gold, citizens,
 * shields, statuses and cooldowns all stay exactly where they were, and the
 * castle on the field is still yours. Only what the ability bar can do changes.
 *
 * ⚠️ THE SWAP IS AN OVERRIDE, NOT A REASSIGNMENT. `player.kingdomId` is used for
 * far more than the kit — the castle's colour, its skin, the roster, the
 * scoreboard, every passive, the win screen — so writing a new kingdom into it
 * would have Water's castle turn into Fire's mid-match and the wrong name on
 * the result. A separate `abilityKingdomId` is read by the ability layer alone,
 * and everything else keeps seeing the kingdom that has been there all along.
 *
 * ⚠️ PASSIVES DO NOT TRAVEL WITH IT, DELIBERATELY. A passive is what a kingdom
 * IS — Ice's retaliation, Dark's boosted perks, Time's scaling — and those are
 * baked into the seat at match start. Thirty seconds of somebody else's active
 * abilities is a party trick; thirty seconds of somebody else's identity is a
 * different match.
 */
export const KINGDOM_SWAP_GAME: PartyGame = {
  id: "kingdomSwap",
  // ⚠️ TWO WORDS, AND THAT IS THE WHOLE ANNOUNCEMENT. This is the one game with
  // nothing to show: the ability bar has already changed underneath the player,
  // which says it better than a sentence would. A card explaining the swap sat
  // over the board for its first seconds — hiding the battlefield the borrowed
  // kit is for, which is the exact opposite of a swap.
  description: "Kingdom Swap",
  timedSeconds: PARTY.SWAP_SECONDS,
  maxSeconds: PARTY.SWAP_SECONDS + 2,
  stopsProduction: false,
  // Thirty seconds with a borrowed kit is meant to be PLAYED, not waited out.
  holdsAttacks: false,

  setup(match, players) {
    const until =
      match.tick + Math.round(param("party.swapSeconds", PARTY.SWAP_SECONDS) * TICK.RATE);

    // Shuffle, then hand each kingdom the NEXT one's kit around the ring. A
    // ring guarantees nobody draws their own, which a pairwise shuffle does
    // not — and "you have your own abilities for thirty seconds" is not a
    // minigame.
    const ring = [...players];
    for (let i = ring.length - 1; i > 0; i--) {
      const j = Math.floor(match.rng() * (i + 1));
      [ring[i], ring[j]] = [ring[j]!, ring[i]!];
    }

    const perPlayer: PartySetup["perPlayer"] = {};
    const given: Record<string, string> = {};
    for (const [index, player] of ring.entries()) {
      const lender = ring[(index + 1) % ring.length]!;
      if (ring.length < 2 || lender.id === player.id) {
        perPlayer[player.id] = { borrowedFrom: null };
        continue;
      }
      player.abilityKingdomId = lender.kingdomId;
      player.abilitySwapUntilTick = until;
      given[player.id] = lender.kingdomId;
      perPlayer[player.id] = {
        borrowedFrom: lender.kingdomId,
        borrowedLabel: kingdomLabel(lender.kingdomId),
      };
    }

    return { shared: { given, untilTick: until }, perPlayer };
  },

  act() {
    return { ok: false, error: "Nothing to press — go and use the kit" };
  },

  bot() {
    // A bot plays its borrowed kit through the ordinary AI, which reads the
    // ability list rather than the kingdom. Nothing to do here.
  },

  result() {
    return null; // "none"
  },
};

/**
 * Hands every borrowed kit back once its time is up.
 *
 * Ticked rather than settled at the end of the session, for the same reason
 * ghosts are: the session can be cleared early or the match can end, and a
 * player left holding somebody else's abilities for the rest of the game is a
 * far worse bug than a swap that ends a tick late.
 */
export function tickKingdomSwaps(match: Match): void {
  const state = match.gameState;
  if (!state) return;
  for (const player of state.getPlayers()) {
    if (player.abilitySwapUntilTick === undefined) continue;
    if (match.tick < player.abilitySwapUntilTick) continue;
    player.abilitySwapUntilTick = undefined;
    player.abilityKingdomId = undefined;
  }
}

/** Which kingdom's kit this player is holding right now. */
export function kitKingdomOf(player: {
  kingdomId: KingdomId;
  abilityKingdomId?: KingdomId;
}): KingdomId {
  return player.abilityKingdomId ?? player.kingdomId;
}

/**
 * The player's OWN ability sitting in the same slot as a borrowed one.
 *
 * ⚠️ WITHOUT THIS, A BORROWED KIT IS A LOCKED KIT. Unlocks and upgrade levels
 * are stored per ability ID — a player who has bought and levelled their own
 * five abilities owns nothing at all in somebody else's list, so a swap would
 * hand them a bar of five buttons they cannot press.
 *
 * Mirroring by SLOT rather than granting the borrowed ids outright is what
 * keeps the swap fair in both directions: every kingdom's kit runs
 * basic → medium → heavy → utility → ultimate, so slot three of the borrowed
 * kit is unlocked exactly if slot three of your own is, at the level you paid
 * for. You cannot gain power by being swapped, and you cannot lose it. What
 * changes is what the buttons DO.
 */
export function mirrorSlot(
  player: { kingdomId: KingdomId; abilityKingdomId?: KingdomId },
  abilityId: string,
): string {
  const borrowedFrom = player.abilityKingdomId;
  if (borrowedFrom === undefined) return abilityId;

  const borrowed = abilitiesForKingdom(borrowedFrom);
  const index = borrowed.findIndex((a) => a.id === abilityId);
  if (index < 0) return abilityId; // not a borrowed ability; nothing to mirror
  return abilitiesForKingdom(player.kingdomId)[index]?.id ?? abilityId;
}

/**
 * Whether a borrowed ability counts as bought, purely because it is borrowed.
 *
 * ⚠️ THE SWAP USED TO HAND OVER A KIT YOU COULD NOT USE. Unlocks are per
 * ability id, so a borrowed ability was locked unless the SAME SLOT of your own
 * kingdom had already been bought — and early in a match almost nothing has
 * been. The result was a player holding five buttons, every one of them locked,
 * with no way to unlock them either, for the full thirty seconds: not a swap, a
 * suspension. So the loan includes the buttons.
 *
 * Upgrades are still your own: `mirrorSlot` reads the level off the matching
 * slot of your real kingdom, so a borrowed kit fires at whatever tier you paid
 * for there and at base level otherwise. You cannot gain power by being
 * swapped — only reach.
 */
export function swapGrantsUnlock(
  player: { kingdomId: KingdomId; abilityKingdomId?: KingdomId },
  abilityId: string,
): boolean {
  const borrowedFrom = player.abilityKingdomId;
  if (borrowedFrom === undefined) return false;
  return abilitiesForKingdom(borrowedFrom).some((a) => a.id === abilityId);
}

/**
 * Whether this player may cast this ability at all right now.
 *
 * While swapped, their own kit is OUT — they have somebody else's abilities,
 * not both. Refusing here rather than only hiding the buttons matters because
 * hiding a button is not a rule.
 */
export function canUseAbility(
  player: { kingdomId: KingdomId; abilityKingdomId?: KingdomId },
  abilityId: string,
): boolean {
  const borrowedFrom = player.abilityKingdomId;
  if (borrowedFrom === undefined) return true;
  return abilitiesForKingdom(borrowedFrom).some((a) => a.id === abilityId);
}
