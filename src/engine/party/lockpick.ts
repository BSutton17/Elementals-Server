import { PARTY } from "../../data/balance.js";
import { earn } from "../money.js";
import { param } from "../parameters.js";
import type { PartyActionResult, PartyGame, PartySetup } from "./types.js";

/**
 * Pick the lock.
 *
 * An indicator sweeps a circular lock; click while it is in the green zone.
 * Five locks in a row pays out. A miss resets THE CURRENT LOCK — not the run —
 * so a bad click costs a few seconds rather than the whole game, and the player
 * who keeps missing is punished by the clock instead of by a wall.
 *
 * ⚠️ BEING LAST PAYS NOTHING. Everyone can finish this, so without that rule
 * the reward is a participation fee for a game nobody can lose. The table is
 * racing each other, not the lock.
 *
 * ⚠️ THE ZONE LIVES ON THE SERVER. The client draws the arc it is told to draw
 * and reports the angle it clicked at; whether that angle was inside the zone
 * is decided here. A client that judged its own hits would pick every lock
 * perfectly, forever, by reporting a hit.
 */

export interface LockState {
  /** Locks already picked, 0..target. */
  picked: number;
  /** Where the green zone starts, in degrees clockwise from 12 o'clock. */
  zoneStart: number;
  /** How wide it is, in degrees. It narrows as the run goes on. */
  zoneWidth: number;
  /** Degrees per second the indicator sweeps — it speeds up too. */
  speed: number;
  /** Misses so far, for the client to rattle the lock. */
  misses: number;
}

/**
 * Rolls the next lock.
 *
 * Each one is a little meaner than the last: a narrower window on a faster
 * sweep. Five identical locks would be one lock repeated, and the fifth should
 * feel like the fifth.
 */
export function nextLock(picked: number, rng: () => number): LockState {
  const baseWidth = param("party.lockZoneDegrees", PARTY.LOCK_ZONE_DEGREES);
  const baseSpeed = param("party.lockSpeedDegrees", PARTY.LOCK_SPEED_DEGREES);
  return {
    picked,
    // Never right at the top: the indicator starts at 0°, and a zone sitting on
    // the start line is picked by clicking instantly, which is not the game.
    zoneStart: 40 + rng() * 280,
    zoneWidth: Math.max(14, baseWidth - picked * 5),
    speed: baseSpeed + picked * 22,
    misses: 0,
  };
}

/** Whether an angle (degrees, 0 = top, clockwise) sits inside the zone. */
export function angleInZone(angle: number, lock: LockState): boolean {
  const normalized = ((angle % 360) + 360) % 360;
  const start = ((lock.zoneStart % 360) + 360) % 360;
  const end = start + lock.zoneWidth;
  if (end <= 360) return normalized >= start && normalized <= end;
  // The zone wraps past 12 o'clock.
  return normalized >= start || normalized <= end - 360;
}

export const LOCKPICK_GAME: PartyGame = {
  id: "lockpick",
  description: "Pick the lock",
  timedSeconds: null,
  maxSeconds: PARTY.LOCKPICK_MAX_SECONDS,
  stopsProduction: true,

  setup(match, players) {
    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) {
      // A lock each: this is a race, and a shared lock would mean everybody
      // clicking on the same beat.
      perPlayer[player.id] = { lock: nextLock(0, match.rng) as unknown as Record<string, unknown> };
    }
    return {
      shared: { target: param("party.lockTarget", PARTY.LOCK_TARGET) },
      perPlayer,
    };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "strike") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "Already finished" };

    const angle = typeof action.angle === "number" ? action.angle : NaN;
    if (!Number.isFinite(angle)) return { ok: false, error: "No angle" };

    const lock = me.data.lock as unknown as LockState;
    const target = session.shared.target as number;

    if (!angleInZone(angle, lock)) {
      // A miss resets the CURRENT lock, not the run: same count, new zone.
      const fresh = nextLock(lock.picked, match.rng);
      fresh.misses = lock.misses + 1;
      me.data.lock = fresh as unknown as Record<string, unknown>;
      return { ok: true };
    }

    const picked = lock.picked + 1;
    if (picked >= target) {
      me.done = true;
      me.outcome = "won";
      me.finishedTick = match.tick;
      me.data.lock = { ...lock, picked } as unknown as Record<string, unknown>;
      // Paid on resolve rather than here — whether this player was LAST is not
      // knowable until the session closes. See `settleLockpick`.
      return { ok: true };
    }

    me.data.lock = nextLock(picked, match.rng) as unknown as Record<string, unknown>;
    return { ok: true };
  },

  bot(match, session, player) {
    const me = session.players[player.id];
    if (!me || me.done) return;
    const lock = me.data.lock as unknown as LockState;
    const target = session.shared.target as number;

    // A bot picks a lock every second or two, with the same chance of fumbling
    // one that a person has.
    const nextAt = (me.data.botNextTick as number | undefined) ?? null;
    if (nextAt === null) {
      me.data.botNextTick = match.tick + Math.round((0.8 + match.rng() * 1.4) * 20);
      return;
    }
    if (match.tick < nextAt) return;
    me.data.botNextTick = match.tick + Math.round((0.8 + match.rng() * 1.4) * 20);

    // ⚠️ BOTS DO NOT MISS HERE, AT ANY DIFFICULTY. The lock is a timing test
    // with no reading and no thinking in it, so a bot that "fails" one is only
    // pretending to have a thumb. What separates a weak bot from a strong one
    // in this game is the pace it picks at, which is rolled above.
    const picked = lock.picked + 1;
    if (picked >= target) {
      me.done = true;
      me.outcome = "won";
      me.finishedTick = match.tick;
      me.data.lock = { ...lock, picked } as unknown as Record<string, unknown>;
      return;
    }
    me.data.lock = nextLock(picked, match.rng) as unknown as Record<string, unknown>;
  },

  result() {
    return null; // "none"
  },
};

/**
 * Pays everyone who picked all five EXCEPT whoever finished last.
 *
 * Called once when the session closes, because "last" is a fact about the whole
 * table and cannot be known while people are still picking. A table of one has
 * no last place to speak of — the only finisher is also the first, and is paid.
 */
export function settleLockpick(
  session: { players: Record<string, { done: boolean; outcome: string | null }>; finishOrder: string[] },
  getPlayer: (id: string) => { id: string } | undefined,
  pay: (playerId: string, amount: number) => void,
): void {
  const finishers = session.finishOrder.filter(
    (id) => session.players[id]?.outcome === "won",
  );
  if (finishers.length === 0) return;
  const lastPaid = finishers.length > 1 ? finishers.length - 1 : finishers.length;
  for (let i = 0; i < lastPaid; i++) {
    const id = finishers[i]!;
    if (getPlayer(id)) pay(id, param("party.lockReward", PARTY.LOCK_REWARD));
  }
}
