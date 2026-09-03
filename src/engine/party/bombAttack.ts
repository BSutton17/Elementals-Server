import { PARTY, TICK } from "../../data/balance.js";
import { applyDamage } from "../combat.js";
import { param } from "../parameters.js";
import { kingdomLabel } from "./results.js";
import { BOMB_PASS_MS, botDifficulty, ticksBetweenMs } from "./bots.js";
import type { Match } from "../../match/Match.js";
import type { PartyActionResult, PartyGame, PartySession, PartySetup } from "./types.js";

/**
 * Don't hold the bomb the longest. Click another kingdom to pass it.
 *
 * ⚠️ CUMULATIVE TIME, NOT WHO IS HOLDING IT AT THE END. That single choice is
 * the whole design. "It explodes on whoever has it when the clock runs out"
 * turns into six players staring at each other and one frantic pass at 0.4
 * seconds — the game is decided by latency and nothing else. Counting the
 * seconds each kingdom held it means passing it early is worth something,
 * holding it while you look for a target costs something, and there is no
 * last-instant escape.
 *
 * ⚠️ THE HELD TIME IS ACCRUED HERE, ONE TICK AT A TIME. Not "arrived at, minus
 * left at" from client timestamps, and not recomputed at the end from the pass
 * log — a tick loop that adds twenty a second to whoever currently holds it
 * cannot drift, cannot be lied about, and survives a player disconnecting
 * mid-hold (they keep accruing, which is correct: nobody took it off them).
 *
 * While it runs, targeting and attacking are off for the whole table — clicking
 * a castle passes the bomb, and a click that both passed the bomb and started
 * an attack would be unusable.
 */
export const BOMB_ATTACK_GAME: PartyGame = {
  id: "bombAttack",
  description:
    "Do not hold the bomb for the longest amount of time. Click on another kingdom to hand it off",
  timedSeconds: PARTY.BOMB_SECONDS,
  maxSeconds: PARTY.BOMB_SECONDS + 2,
  stopsProduction: false,

  setup(match, players) {
    const first = players[Math.floor(match.rng() * players.length)]!;
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) perPlayer[player.id] = { heldTicks: 0 };
    return {
      shared: {
        holderId: first.id,
        // Purely for the client's benefit: it flashes the hand-off.
        passes: 0,
        lastPassTick: match.tick,
      },
      perPlayer,
    };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "pass") return { ok: false, error: "Unknown action" };
    if (session.shared.holderId !== player.id) {
      return { ok: false, error: "You do not have it" };
    }
    const targetId = typeof action.targetId === "string" ? action.targetId : "";
    if (targetId === player.id) return { ok: false, error: "Pass it to someone else" };

    const target = match.gameState?.getPlayer(targetId);
    if (!target || target.eliminated || !session.players[targetId]) {
      return { ok: false, error: "Not a kingdom you can pass to" };
    }

    session.shared.holderId = targetId;
    session.shared.passes = ((session.shared.passes as number) ?? 0) + 1;
    session.shared.lastPassTick = match.tick;
    return { ok: true };
  },

  tickSession(_match, session) {
    // The holder pays a tick. ONCE per tick, not once per player — held time
    // belongs to the bomb, and billing it from the per-player hook would charge
    // the holder once for every seat at the table.
    const holderId = session.shared.holderId as string | undefined;
    if (!holderId) return;
    const holder = session.players[holderId];
    if (!holder) return;
    holder.data.heldTicks = ((holder.data.heldTicks as number) ?? 0) + 1;
  },

  bot(match, session, player) {
    if (session.shared.holderId !== player.id) return;
    // A bot holds it for a beat and then throws it at somebody at random — long
    // enough that it is not a hot potato bouncing every frame, short enough
    // that a bot does not simply lose this every time.
    const holdUntil = (session.players[player.id]!.data.botHoldUntil as number | undefined) ?? null;
    if (holdUntil === null) {
      // Fractions of a second, not seconds: this is reflex, and a bot that sat
      // on the bomb for two seconds would lose every game to a human who
      // passes in half of one.
      const [low, high] = BOMB_PASS_MS[botDifficulty(match, player.id)];
      session.players[player.id]!.data.botHoldUntil =
        match.tick + ticksBetweenMs(match.rng, low, high);
      return;
    }
    if (match.tick < holdUntil) return;
    session.players[player.id]!.data.botHoldUntil = undefined;

    const others = Object.keys(session.players).filter(
      (id) => id !== player.id && match.gameState?.getPlayer(id)?.eliminated === false,
    );
    if (others.length === 0) return;
    const victim = others[Math.floor(match.rng() * others.length)]!;
    session.shared.holderId = victim;
    session.shared.passes = ((session.shared.passes as number) ?? 0) + 1;
    session.shared.lastPassTick = match.tick;
  },

  result(match, session) {
    const loser = longestHolder(match, session);
    if (!loser) return null;
    const player = match.gameState?.getPlayer(loser);
    if (!player) return null;
    return `${kingdomLabel(player.kingdomId)} has exploded`;
  },
};

/** Whoever carried it longest, all told. */
export function longestHolder(match: Match, session: PartySession): string | null {
  let worstId: string | null = null;
  let worst = -1;
  for (const [id, state] of Object.entries(session.players)) {
    if (!match.gameState?.getPlayer(id)) continue;
    const held = (state.data.heldTicks as number) ?? 0;
    if (held > worst) {
      worst = held;
      worstId = id;
    }
  }
  return worstId;
}

/** Detonates on the kingdom that held it longest. */
export function settleBombAttack(match: Match, session: PartySession): void {
  const loserId = longestHolder(match, session);
  if (!loserId) return;
  const loser = match.gameState?.getPlayer(loserId);
  if (!loser || loser.eliminated) return;

  const applied = applyDamage(loser, param("party.bombDamage", PARTY.BOMB_DAMAGE), {
    tick: match.tick,
  });

  // ⚠️ ANNOUNCED, NOT JUST APPLIED. Damage dealt without a `damage` event is
  // damage nobody sees: no floating number, no hit reaction, a health bar that
  // simply drops. The explosion is the loudest moment this minigame has, and it
  // was silent — the number is how a player learns what the bomb cost them.
  const bus = match.gameState?.events;
  if (bus?.enabled) {
    bus.emit({
      type: "damage",
      tick: match.tick,
      sourceId: loserId,
      targetId: loserId,
      amount: applied.absorbedByShield + applied.dealtToHp,
      absorbedByShield: applied.absorbedByShield,
      dealtToHp: applied.dealtToHp,
      overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
      crit: false,
      cause: "bomb",
    });
  }
  for (const [id, state] of Object.entries(session.players)) {
    state.done = true;
    state.finishedTick ??= match.tick;
    state.outcome = id === loserId ? "lost" : "won";
    if (id === loserId) state.data.exploded = true;
  }
}

/** True while a bomb game is running — targeting and attacks are off. */
export function bombIsLive(match: Match): boolean {
  const session = match.gameState?.party;
  return (
    session !== null &&
    session !== undefined &&
    session.gameId === "bombAttack" &&
    session.resolvedTick === null
  );
}
