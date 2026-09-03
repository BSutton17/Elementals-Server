import { PARTY } from "../../data/balance.js";
import { earn, getBalance, roundMoney } from "../money.js";
import { param } from "../parameters.js";
import type { Match } from "../../match/Match.js";
import type { PlayerState } from "../../match/playerState.js";
import type { PartyActionResult, PartyGame, PartySession, PartySetup } from "./types.js";

/**
 * Pick a chest.
 *
 * Three chests: a good one, a poor one, and a trap. There is no skill in this
 * and there is not meant to be — it is the one minigame where a player who has
 * been quietly winning all match can be handed a bill for nothing at all, and
 * everybody watches it happen at the same moment.
 *
 * ⚠️ EVERY KINGDOM GETS ITS OWN SHUFFLE. One shared arrangement would mean the
 * first player to open a chest tells everyone else where the trap is not — and
 * on a shared screen, the last to pick would simply be told the answer.
 *
 * ⚠️ AND WHAT IS INSIDE IS NEVER ON THE WIRE UNTIL IT IS OPENED. The prizes are
 * held server-side (see `sanitizeForWire`); the client is told three chests
 * exist and which one this player chose.
 */

export type ChestPrize = "big" | "small" | "trap";

/** The three, shuffled, for one player. */
export function shuffleChests(rng: () => number): ChestPrize[] {
  const chests: ChestPrize[] = ["big", "small", "trap"];
  for (let i = chests.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [chests[i], chests[j]] = [chests[j]!, chests[i]!];
  }
  return chests;
}

export const PICK_A_CHEST_GAME: PartyGame = {
  id: "pickAChest",
  description: "Pick a chest",
  timedSeconds: PARTY.CHOICE_SECONDS,
  maxSeconds: PARTY.CHOICE_SECONDS + 2,
  stopsProduction: false,

  setup(match, players) {
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) {
      perPlayer[player.id] = { chests: shuffleChests(match.rng), picked: null, prize: null };
    }
    return { shared: {}, perPlayer };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "open") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "Already opened one" };

    const index = typeof action.index === "number" ? Math.floor(action.index) : -1;
    if (index < 0 || index > 2) return { ok: false, error: "There are three chests" };

    openChest(match, session, player, index);
    return { ok: true };
  },

  bot(match, session, player) {
    const me = session.players[player.id];
    if (!me || me.done) return;
    // ⚠️ NO DIFFICULTY HERE, AT ALL. There is nothing to be good at: a hard bot
    // cannot see through wood. It picks at random, like everybody else.
    if (me.data.botPickTick === undefined) {
      me.data.botPickTick = session.startedTick + Math.round((1 + match.rng() * 4.5) * 20);
      return;
    }
    if (match.tick < (me.data.botPickTick as number)) return;
    openChest(match, session, player, Math.floor(match.rng() * 3));
  },

  forceFinish(match, session, player) {
    // Ten seconds passed and they did not choose, so the chest chooses.
    // Leaving them out would make "look away" the safe play in the one game
    // that is supposed to be pure nerve.
    const me = session.players[player.id];
    if (me) me.data.defaulted = true;
    openChest(match, session, player, Math.floor(match.rng() * 3));
  },

  result() {
    return null; // "none" — the chest itself is the announcement
  },

  sanitizeForWire(data) {
    // The arrangement is the secret. Once a chest has been opened the player
    // may see what was in THEIRS, and nothing else.
    const picked = data.picked as number | null;
    return {
      ...data,
      chests: undefined,
      prize: picked === null ? null : data.prize,
    };
  },
};

/** Opens one, pays or bills, and ends that player's turn. */
function openChest(
  match: Match,
  session: PartySession,
  player: PlayerState,
  index: number,
): void {
  const me = session.players[player.id];
  if (!me || me.done) return;
  const chests = me.data.chests as ChestPrize[];
  const prize = chests[index] ?? "small";

  me.data.picked = index;
  me.data.prize = prize;
  me.done = true;
  me.finishedTick = match.tick;

  if (prize === "big") {
    earn(player, param("party.chestBig", PARTY.CHEST_BIG));
    me.outcome = "won";
    return;
  }
  if (prize === "small") {
    earn(player, param("party.chestSmall", PARTY.CHEST_SMALL));
    me.outcome = "won";
    return;
  }

  // The trap takes gold, not health — and a purse that cannot cover it is not
  // pushed below zero. The shortfall becomes production debt, exactly as a
  // Blackjack loss does, so there is one rule in the game for "you owe more
  // than you have" rather than two.
  const cost = param("party.chestTrap", PARTY.CHEST_TRAP);
  const purse = getBalance(player);
  const paid = Math.min(purse, cost);
  player.economy.currency = roundMoney(purse - paid);
  const owed = cost - paid;
  if (owed > 0) {
    player.economy.productionDebt = roundMoney((player.economy.productionDebt ?? 0) + owed);
    me.data.owed = owed;
  }
  me.outcome = "lost";
}
