import { COMBAT, TICK } from "../data/balance.js";
import { param } from "./parameters.js";
import { createSiegeWatch } from "../match/playerState.js";
import type { Match } from "../match/Match.js";
import type { PlayerState, SiegeWatch } from "../match/playerState.js";

/**
 * Persistent-siege escalation.
 *
 * The besieged curve (`engine/passives.ts`) reads the number of kingdoms aiming
 * at you *right now*, and is deliberately gentle at two attackers, because two
 * kingdoms picking the same target at the same moment is usually coincidence.
 *
 * Coincidence does not last a minute. This module watches for the case the raw
 * count cannot see — the SAME small group staying on one kingdom — and grants
 * the victim extra besieged stages for it. A coalition that holds for
 * `SIEGE_ESCALATION_TIER_SECONDS[0]` is worth one extra stage, and one that
 * holds for `[1]` is worth two. There is no third.
 *
 * Three rules make it hard to game, and they are the whole design:
 *
 *  1. **It must be the same kingdoms.** Swap a member and the clock restarts —
 *     a rotating cast is not the team the rule is aimed at.
 *  2. **A brief look away pauses the clock, it does not reset it.** Otherwise
 *     a coalition drops one member for a single tick every 59 seconds and the
 *     rule never fires. Leave for five seconds and return: you resume five
 *     seconds behind, which is exactly what the absence was worth.
 *  3. **Earned stages are a FLOOR.** Changing shape restarts the clock but
 *     never refunds a stage already earned, so a group cannot cycle members to
 *     strip the victim's protection. The floor is released only when the siege
 *     genuinely ends.
 *
 * Reads targeting state and writes only `player.siege`; the escalation is
 * applied in `besiegedStacks`.
 */

const tierTicks = (): number[] =>
  COMBAT.SIEGE_ESCALATION_TIER_SECONDS.map((seconds, i) =>
    Math.round(
      param(`combat.siegeEscalationTierSeconds.${i + 1}`, seconds) *
        param("tick.rate", TICK.RATE),
    ),
  );

const graceTicks = (): number =>
  Math.round(
    param("combat.siegeAbsenceGraceSeconds", COMBAT.SIEGE_ABSENCE_GRACE_SECONDS) *
      param("tick.rate", TICK.RATE),
  );

const minMembers = (): number =>
  param("combat.siegeEscalationMinMembers", COMBAT.SIEGE_ESCALATION_MIN_MEMBERS);

const maxMembers = (): number =>
  param("combat.siegeEscalationMaxMembers", COMBAT.SIEGE_ESCALATION_MAX_MEMBERS);

/** The extra besieged stages this kingdom's persistent siege has earned. */
export function siegeEscalation(player: PlayerState): number {
  return player.siege?.level ?? 0;
}

/** Living kingdoms currently aiming at `victim`, as sorted ids. */
function currentBesiegers(
  victim: PlayerState,
  allPlayers: readonly PlayerState[],
): string[] {
  return allPlayers
    .filter((p) => !p.eliminated && p.id !== victim.id && p.target === victim.id)
    .map((p) => p.id)
    .sort();
}

/** A coalition size the escalation rule applies to at all. */
function qualifies(size: number): boolean {
  return size >= minMembers() && size <= maxMembers();
}

/**
 * Begins timing `members` while preserving whatever stages were already earned
 * — restarting the clock must never refund a stage (rule 3).
 */
function retrack(watch: SiegeWatch, members: string[]): void {
  watch.members = qualifies(members.length) ? [...members] : [];
  watch.heldTicks = 0;
  watch.absent = {};
}

/** Advances one kingdom's siege watch by a tick. */
function tickOne(
  victim: PlayerState,
  allPlayers: readonly PlayerState[],
  tick: number,
): void {
  if (!victim.siege) victim.siege = createSiegeWatch();
  const watch = victim.siege;
  const current = currentBesiegers(victim, allPlayers);
  const currentSet = new Set(current);
  const grace = graceTicks();
  const living = new Set(
    allPlayers.filter((p) => !p.eliminated).map((p) => p.id),
  );

  // ⚠️ ABSENCE BOOKKEEPING RUNS FIRST, before anything asks whether a siege is
  // still happening. A member looking away drops the live attacker count to one,
  // and if that were read as "the siege ended" the very first tick of a
  // look-away would release the floor — handing back exactly the reset the grace
  // window exists to deny.
  const missing = watch.members.filter((id) => !currentSet.has(id));
  for (const id of missing) {
    if (watch.absent[id] === undefined) watch.absent[id] = tick;
  }
  for (const id of current) delete watch.absent[id];

  // Members who are away but still excused: alive, and inside their grace.
  // An eliminated member is never excused — they are not coming back, and
  // holding their seat for ten seconds would be pure fiction.
  const excused = missing.filter((id) => {
    if (!living.has(id)) return false;
    const since = watch.absent[id];
    return since !== undefined && tick - since <= grace;
  });

  // The siege is over — nobody is on this kingdom any more, excused members
  // included. Release the floor.
  if (current.length + excused.length < minMembers()) {
    if (watch.level !== 0 || watch.members.length > 0 || watch.heldTicks !== 0) {
      victim.siege = createSiegeWatch();
    }
    return;
  }

  // Nothing being timed yet (or the last coalition grew too large to qualify):
  // pick this one up if it qualifies. Any earned level rides along as the floor.
  if (watch.members.length === 0) {
    if (qualifies(current.length)) retrack(watch, current);
    return;
  }

  const tracked = new Set(watch.members);
  const joined = current.filter((id) => !tracked.has(id));
  // Missing and NOT excused: gone for good, or gone too long.
  const gone = missing.length > excused.length;

  // A genuinely different coalition — someone joined, or someone left for real.
  // Restart the clock on whoever is here now; the earned level stays.
  if (joined.length > 0 || gone) {
    retrack(watch, current);
    return;
  }

  // Someone is away but still inside their grace: PAUSE. The banked time is
  // kept, so they resume from exactly where they left off.
  if (missing.length > 0) return;

  // Intact for another tick.
  watch.heldTicks += 1;
  const tiers = tierTicks();
  for (let i = 0; i < tiers.length; i++) {
    if (watch.heldTicks >= tiers[i]!) watch.level = Math.max(watch.level, i + 1);
  }
}

/**
 * Advances every kingdom's siege watch. Runs once per tick, before economy, so
 * a stage earned this tick is worth gold on the same tick it is earned.
 */
export function tickSiegeWatches(match: Match): void {
  const state = match.gameState;
  if (!state) return;
  const players = state.getPlayers();
  for (const victim of players) {
    if (victim.eliminated) {
      if (victim.siege && victim.siege.level !== 0) victim.siege = createSiegeWatch();
      continue;
    }
    tickOne(victim, players, match.tick);
  }
}
