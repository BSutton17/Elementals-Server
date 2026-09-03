import { PARTY, TICK } from "../../data/balance.js";
import { earn } from "../money.js";
import { param } from "../parameters.js";
import { between, botDifficulty, successChance } from "./bots.js";
import type { PartyActionResult, PartyGame, PartySetup } from "./types.js";

/**
 * Earn as much gold as you can in ten seconds.
 *
 * Coins fall down the screen. Bronze is worth 25, silver 50, gold 100, and they
 * get rarer in that order. Catch what you can.
 *
 * ⚠️ THE COINS ARE DEALT BY THIS SIDE, NOT SPAWNED BY THAT ONE. Every coin in
 * the fall is generated here with an id, a kind and a position, and a catch is
 * a claim against ONE id: caught twice, or caught by two players, or caught
 * after the fall is over, and it pays nothing. A client that spawned its own
 * coins would be a client that decides its own income — which is the single
 * easiest thing in this whole mode to cheat, and it pays real gold.
 */

export type CoinKind = "bronze" | "silver" | "gold";

export interface Coin {
  id: number;
  kind: CoinKind;
  /** Where it falls, as a fraction of the screen's width. */
  x: number;
  /** Tick it enters at, so every client drops it at the same moment. */
  atTick: number;
}

const VALUE: Record<CoinKind, keyof typeof PARTY> = {
  bronze: "COIN_BRONZE",
  silver: "COIN_SILVER",
  gold: "COIN_GOLD",
};

/**
 * Rolls the whole shower up front.
 *
 * ⚠️ ALL OF IT AT SETUP, NOT COIN BY COIN AS IT FALLS. A shower generated on
 * the fly would need the server to push a message per coin, and every client
 * would see a slightly different rain depending on when its packets landed.
 * Dealt in one go, every screen shows the same coins in the same places, which
 * matters the moment two players compare what they caught.
 */
export function buildShower(rng: () => number, seconds: number): Coin[] {
  const coins: Coin[] = [];
  const perSecond = param("party.coinsPerSecond", PARTY.COINS_PER_SECOND);
  const total = Math.round(seconds * perSecond);

  for (let i = 0; i < total; i++) {
    // Gold is rare, silver uncommon, bronze the bulk of it — the thresholds
    // are read in that order so the rarity ladder is legible here rather than
    // buried in arithmetic.
    const roll = rng();
    const kind: CoinKind = roll < 0.08 ? "gold" : roll < 0.3 ? "silver" : "bronze";
    coins.push({
      id: i,
      kind,
      // Kept off the very edges: a coin half off-screen is one nobody can catch.
      x: 0.08 + rng() * 0.84,
      atTick: Math.round((i / total) * seconds * TICK.RATE),
    });
  }
  return coins;
}

export const GOLD_PARTY_GAME: PartyGame = {
  id: "goldParty",
  description: "Earn as much gold as you can in 10 seconds",
  timedSeconds: PARTY.GOLD_PARTY_SECONDS,
  maxSeconds: PARTY.GOLD_PARTY_SECONDS + 2,
  // Ordinary production keeps running: this is a bonus, not a substitute.
  stopsProduction: false,
  // Coins fall over a live battlefield; the war carries on underneath.
  holdsAttacks: false,

  setup(match, players) {
    const coins = buildShower(match.rng, param("party.goldPartySeconds", PARTY.GOLD_PARTY_SECONDS));
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) perPlayer[player.id] = { caught: [], earned: 0 };
    return { shared: { coins: coins as unknown as Record<string, unknown> }, perPlayer };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "catch") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "The rain has stopped" };

    const id = typeof action.coinId === "number" ? Math.floor(action.coinId) : -1;
    const coins = session.shared.coins as unknown as Coin[];
    const coin = coins.find((c) => c.id === id);
    if (!coin) return { ok: false, error: "No such coin" };

    // One claim per coin per player. The list is small (a few dozen) and this
    // is the only thing standing between a fast script and free gold.
    const caught = me.data.caught as number[];
    if (caught.includes(id)) return { ok: false, error: "Already caught" };

    // A coin cannot be caught before it has fallen, either.
    if (match.tick < session.startedTick + coin.atTick) {
      return { ok: false, error: "That one has not fallen yet" };
    }

    caught.push(id);
    const value = param(`party.coin.${coin.kind}`, PARTY[VALUE[coin.kind]] as number);
    me.data.earned = ((me.data.earned as number) ?? 0) + value;
    earn(player, value);
    return { ok: true };
  },

  bot(match, session, player) {
    const me = session.players[player.id];
    if (!me || me.done) return;
    const coins = session.shared.coins as unknown as Coin[];
    const caught = me.data.caught as number[];

    // A bot reaches for a coin every second or two and catches it as often as
    // its difficulty says. It cannot see the whole shower at once any more than
    // a person can.
    if (me.data.botNextGrab === undefined) {
      me.data.botNextGrab = match.tick + Math.round(between(match.rng, 1, 2.75) * TICK.RATE);
      return;
    }
    if (match.tick < (me.data.botNextGrab as number)) return;
    me.data.botNextGrab = match.tick + Math.round(between(match.rng, 1, 2.75) * TICK.RATE);

    const elapsed = match.tick - session.startedTick;
    const available = coins.filter((c) => c.atTick <= elapsed && !caught.includes(c.id));
    if (available.length === 0) return;
    if (match.rng() >= successChance(botDifficulty(match, player.id))) return;

    const coin = available[Math.floor(match.rng() * available.length)]!;
    caught.push(coin.id);
    const value = param(`party.coin.${coin.kind}`, PARTY[VALUE[coin.kind]] as number);
    me.data.earned = ((me.data.earned as number) ?? 0) + value;
    earn(player, value);
  },

  result() {
    return null; // "none"
  },
};
