import type { GameState } from "../match/GameState.js";
import type {
  ModifierOp,
  PlayerState,
  StatusEffectInstance,
  StatusTickEffect,
} from "../match/playerState.js";
import { type EffectCondition } from "./conditions.js";
import { addModifier, removeModifiersFromSource, computeStat } from "./modifiers.js";
import { applyDamage } from "./combat.js";
import { statusDurationMultiplier, dotResistanceMultiplier } from "./passives.js";
import { perkDamageTakenMultiplier, perkDotDamageTakenMultiplier } from "./perks.js";
import { param } from "./parameters.js";
import { TICK } from "../data/balance.js";
import { recalcIncome } from "./economy.js";

/**
 * Reusable status-effect framework (tickets #47, #76–#80): apply, update, and
 * remove gameplay status effects on players. It owns the full lifecycle —
 * application with configurable duration, stacking behavior, and source
 * tracking (#76); removal/dispel with restoration of any modified player
 * statistics (#77); and per-tick processing of recurring effect logic (#78).
 *
 * This is also the buff (#79) and debuff (#80) framework: a buff/debuff is a
 * status definition (data, no kingdom-specific logic) composing two generic
 * capabilities —
 *   • `modifiers`: temporary stat changes (crit chance, production/income,
 *     damage, healing, …) applied through the shared modifier system while the
 *     status is active and automatically removed with it;
 *   • `tickEffects`: recurring per-tick damage/healing (burn, poison, regen),
 *     optionally scaling with stacks.
 * e.g. burn = debuff + damage tickEffect; frozen production = debuff +
 * income ×0 modifier; crit surge = buff + critChance modifier.
 *
 * A player holds at most one instance per status id; re-application is resolved
 * by the definition's stacking rule.
 */

export type StatusCategory = "buff" | "debuff" | "crowdControl";
export type StatusStacking = "none" | "refresh" | "stack" | "extend" | "replace";

/** A temporary stat change granted while a status is active (#79/#80). */
export interface StatusModifierSpec {
  stat: string;
  op: ModifierOp;
  value: number;
  /** Conditional modifiers (ticket #101). */
  conditions?: EffectCondition[];
  stringValue?: string;
  usageLimit?: number;
}

export interface StatusEffectDefinition {
  id: string;
  /** Human-readable display name (optional; for UI). */
  name?: string;
  category: StatusCategory;
  /** How re-application behaves when the status is already present. */
  stacking: StatusStacking;
  /** Cap for `stacking: "stack"` (unbounded if omitted). */
  maxStacks?: number;
  /** Stat modifiers active while the status lasts; removed with it (#77). */
  modifiers?: StatusModifierSpec[];
  /** Recurring per-tick effects executed by `processStatusTicks` (#78). */
  tickEffects?: StatusTickEffect[];
  /**
   * While active, the bearer cannot target the player who applied the status
   * (#87–#88). Targeting anyone else stays legal.
   */
  blocksTargetingSource?: boolean;
  /**
   * While active, the bearer's next attack on the player who applied the
   * status is deflected to another valid kingdom, the attacker included
   * (Air's Hurricane, Epic 8). Consumed on use by the activation pipeline.
   *  - `damageMult`: the deflected attack deals this multiplier to the
   *    redirected target (Hurricane Lv 3).
   *  - `chainChance`: one roll to allow a second deflection before the mark
   *    is consumed — 1 deflection becomes 2, never more (Hurricane Lv 5).
   */
  deflectsAttackOnSource?: { damageMult?: number; chainChance?: number };
  /** While active, the bearer cannot activate attack-kind abilities
   *  (Ice's Frozen/Blizzard, Epic 11). */
  blocksAttacks?: boolean;
  /**
   * While active, chance-gated effects of the bearer's attacks always proc;
   * the activation pipeline consumes one stack per attack (Ice's Frozen
   * Focus, Epic 11).
   */
  guaranteesChanceEffects?: boolean;
  /** Applied to the bearer when this status expires naturally (Epic 11,
   *  e.g. thawing from Frozen briefly slows production). */
  onExpireStatus?: { status: StatusEffectDefinition; durationTicks: number };
  /**
   * Overrides `stacking` while the bearer has the named status (Epic 12,
   * e.g. Poison stacks while Corroded but merely refreshes otherwise).
   */
  stackingWhileStatus?: { statusId: string; stacking: StatusStacking };
  /** While active, the bearer cannot buy citizens or repair (Epic 12,
   *  Nature's Toxic Gas). */
  blocksPurchases?: boolean;
  /** Applied to the next player who damages the bearer, then consumed
   *  (Epic 12, Nature's Poison Apple). */
  onHitRetaliate?: { status: StatusEffectDefinition; durationTicks: number };
  /** Additional statuses applied to the biter alongside `onHitRetaliate` when
   *  the mark springs (Poison Apple also poisons the biter's citizens). Applied
   *  and consumed together with the primary retaliation. */
  onHitRetaliateExtra?: { status: StatusEffectDefinition; durationTicks: number }[];
  /**
   * While active, time runs backward on the bearer's treasury: instead of
   * earning passive income, they LOSE it each tick (floored at 0). Drains gold
   * at their own gold/sec rate (Time's "Back to the Future").
   */
  drainsIncome?: boolean;
  /**
   * While active, the bearer cannot change target (Space's Supernova L2/L3
   * forced redirect). The forced target and the target to restore on expiry are
   * set on the instance when applied.
   */
  blocksTargetChange?: boolean;
  /**
   * While active, each incoming attack on the bearer has this probability (0–1)
   * to miss entirely (Space's Orion's Belt). Snapshotted on apply.
   */
  incomingMissChance?: number;
  /**
   * When an incoming attack misses via `incomingMissChance`, add this many
   * points to the bearer's Supernova meter (Orion's Belt feeds the meter).
   */
  missChargesSupernova?: number;
  /**
   * While active, whenever the STATUS'S SOURCE (the applier) takes damage,
   * the bearer also takes this fraction of it (Love's Cupid's Arrow —
   * "infatuated" kingdoms feel a share of what Love feels).
   */
  bearerTakesPctOfSourceDamage?: number;
  /**
   * While active, ANY damage the bearer takes is instead fully negated and
   * converted into healing for this fraction of the raw incoming amount
   * (Love's "Love Galore").
   */
  negateDamageHealPct?: number;
  /**
   * While active, damage the bearer takes is reflected back at the attacker
   * in full proportion (no chance roll — unlike the passive `thorns`, which
   * rolls per hit) at this fraction (Love's "Have some Empathy!", 1 = 100%).
   */
  thornsPct?: number;
  /**
   * A two-phase status that stays HIDDEN until it reveals (Love's "Love
   * Galore"). While unrevealed, its damage-negation heals the bearer silently
   * and enemies see phantom damage numbers instead. It reveals when EITHER the
   * initial (stealth) window elapses OR `negateDamageHealPct` healing reaches
   * `revealHealThreshold` — whichever comes first — at which point the status
   * restarts for a fresh window of the same length, now fully visible.
   */
  revealsBeforeExpiry?: boolean;
  /** Cumulative negated-damage healing that triggers an early reveal (paired
   *  with `revealsBeforeExpiry`; passed through the applying effect's params so
   *  it scales with upgrades). */
  revealHealThreshold?: number;
}

/**
 * Whether `player` is currently barred from targeting `targetId` by an active
 * status (#88). Used by both target selection and ability activation.
 */
export function isTargetingBlocked(
  player: PlayerState,
  targetId: string,
): boolean {
  return player.statuses.some(
    (s) => s.blocksTargetingSource && s.sourceId === targetId,
  );
}

/** The modifier `sourceId` a status's linked stat changes are tracked under. */
export function statusModifierSource(statusId: string): string {
  return `status:${statusId}`;
}

export interface ApplyStatusOptions {
  sourceId: string;
  durationTicks: number;
  /** Stacks applied (default 1). */
  stacks?: number;
}

/** A status removed during processing, for callers that react to expiry. */
export interface RemovedStatus {
  playerId: string;
  status: StatusEffectInstance;
}

/** Applies a status to a player, resolving re-application via its stacking rule. */
export function applyStatus(
  player: PlayerState,
  definition: StatusEffectDefinition,
  options: ApplyStatusOptions,
): StatusEffectInstance {
  const stacks = options.stacks ?? 1;
  // Kingdom passives may shorten how long this status lasts on its recipient
  // (ticket #81, e.g. Water's reduced Burn duration). Applied to every path
  // that consumes the duration (fresh apply, refresh, stack, extend).
  const durationTicks = Math.round(
    options.durationTicks * statusDurationMultiplier(player, definition.id),
  );
  const existing = player.statuses.find((s) => s.id === definition.id);

  // Conditional stacking (Epic 12): e.g. Poison stacks while the bearer is
  // Corroded, but merely refreshes otherwise.
  let stacking = definition.stacking;
  if (
    definition.stackingWhileStatus &&
    hasStatus(player, definition.stackingWhileStatus.statusId)
  ) {
    stacking = definition.stackingWhileStatus.stacking;
  }

  if (!existing) {
    const instance: StatusEffectInstance = {
      id: definition.id,
      sourceId: options.sourceId,
      remainingTicks: durationTicks,
      stacks,
      // Snapshot the recurring effects so per-tick processing needs no
      // definition lookup (#78).
      tickEffects: definition.tickEffects?.map((t) => ({ ...t })),
      initialDurationTicks: durationTicks,
      blocksTargetingSource: definition.blocksTargetingSource,
      deflectsAttackOnSource: definition.deflectsAttackOnSource
        ? { ...definition.deflectsAttackOnSource }
        : undefined,
      blocksAttacks: definition.blocksAttacks,
      guaranteesChanceEffects: definition.guaranteesChanceEffects,
      onExpireStatus: definition.onExpireStatus,
      blocksPurchases: definition.blocksPurchases,
      onHitRetaliate: definition.onHitRetaliate,
      onHitRetaliateExtra: definition.onHitRetaliateExtra,
      drainsIncome: definition.drainsIncome,
      blocksTargetChange: definition.blocksTargetChange,
      incomingMissChance: definition.incomingMissChance,
      missChargesSupernova: definition.missChargesSupernova,
      bearerTakesPctOfSourceDamage: definition.bearerTakesPctOfSourceDamage,
      negateDamageHealPct: definition.negateDamageHealPct,
      thornsPct: definition.thornsPct,
      revealsBeforeExpiry: definition.revealsBeforeExpiry,
      hasModifiers: (definition.modifiers ?? []).length > 0,
    };
    player.statuses.push(instance);

    // A targeting ban severs an existing lock-on too: if the bearer is
    // currently aiming at the applier, the target is cleared and the switch
    // cooldown waived so they can immediately aim elsewhere (#87–#88).
    if (definition.blocksTargetingSource && player.target === options.sourceId) {
      player.target = null;
      player.targetSwitchReadyTick = 0;
    }

    // Linked stat modifiers live exactly as long as the status (#79/#80);
    // they are removed with it, restoring the player's statistics (#77).
    for (const [i, spec] of (definition.modifiers ?? []).entries()) {
      addModifier(player, {
        id: `${statusModifierSource(definition.id)}:${i}`,
        stat: spec.stat,
        op: spec.op,
        value: spec.value,
        sourceId: statusModifierSource(definition.id),
        remainingTicks: null, // lifecycle bound to the status, not a timer
        conditions: spec.conditions,
        stringValue: spec.stringValue,
        usageLimit: spec.usageLimit,
      });
    }
    return instance;
  }

  switch (stacking) {
    case "none":
      // Already present — leave it untouched.
      break;
    case "refresh":
      existing.remainingTicks = durationTicks;
      existing.sourceId = options.sourceId;
      // Re-application renews the effect: restart its elapsed clock so ramping
      // DoTs and half-life steps measure from this fresh application.
      existing.tickElapsed = 0;
      existing.initialDurationTicks = durationTicks;
      // Re-application wins: a stronger variant's recurring effects replace
      // the snapshot (Epic 12, e.g. strong Poison over weak).
      if (definition.tickEffects) {
        existing.tickEffects = definition.tickEffects.map((t) => ({ ...t }));
      }
      break;
    case "replace":
      removeStatus(player, definition.id);
      return applyStatus(player, definition, options);
    case "stack": {
      const max = definition.maxStacks ?? Number.POSITIVE_INFINITY;
      existing.stacks = Math.min(existing.stacks + stacks, max);
      existing.remainingTicks = durationTicks;
      existing.sourceId = options.sourceId;
      existing.tickElapsed = 0;
      existing.initialDurationTicks = durationTicks;
      if (definition.tickEffects) {
        existing.tickEffects = definition.tickEffects.map((t) => ({ ...t }));
      }
      break;
    }
    case "extend":
      existing.remainingTicks += durationTicks;
      break;
  }
  return existing;
}

/**
 * Removes (dispels) a status from a player (#77). Any stat modifiers the
 * status granted are removed with it, restoring the player's statistics.
 * Returns true if one was removed.
 */
export function removeStatus(player: PlayerState, statusId: string): boolean {
  const before = player.statuses.length;
  player.statuses = player.statuses.filter((s) => s.id !== statusId);
  const removed = player.statuses.length < before;
  if (removed) {
    removeModifiersFromSource(player, statusModifierSource(statusId));
  }
  return removed;
}

/**
 * Prunes statuses whose modifiers have been fully consumed (e.g. Blazing
 * Determination once its one-shot damage buff is spent). Returns the removed
 * statuses so callers can emit `statusExpired` for them — consumers (VFX,
 * replays, recorders) can't otherwise tell a usage-exhausted buff has ended.
 */
export function pruneExhaustedStatuses(player: PlayerState): StatusEffectInstance[] {
  const keptStatuses: StatusEffectInstance[] = [];
  const removed: StatusEffectInstance[] = [];
  for (const s of player.statuses) {
    if (s.hasModifiers) {
      const hasActiveMod = player.modifiers.some((m) => m.sourceId === statusModifierSource(s.id));
      if (!hasActiveMod) {
        removeModifiersFromSource(player, statusModifierSource(s.id));
        removed.push(s);
        continue;
      }
    }
    keptStatuses.push(s);
  }
  player.statuses = keptStatuses;
  return removed;
}

export function getStatus(
  player: PlayerState,
  statusId: string,
): StatusEffectInstance | undefined {
  return player.statuses.find((s) => s.id === statusId);
}

export function hasStatus(player: PlayerState, statusId: string): boolean {
  return player.statuses.some((s) => s.id === statusId);
}

/**
 * Advances every player's status durations by one tick, removing expired ones
 * and stripping their linked stat modifiers (#77 — expiry restores statistics).
 * Returns the removed statuses so callers can run onExpire effects / emit events.
 */
export function tickStatuses(state: GameState): RemovedStatus[] {
  const bus = state.events;
  const removed: RemovedStatus[] = [];
  for (const player of state.getPlayers()) {
    // Usage-exhausted statuses removed this tick still report as expired.
    for (const s of pruneExhaustedStatuses(player)) {
      if (bus.enabled) {
        bus.emit({ type: "statusExpired", tick: state.tick, playerId: player.id, statusId: s.id });
      }
    }

    const kept: StatusEffectInstance[] = [];
    const expired: StatusEffectInstance[] = [];
    for (const status of player.statuses) {
      status.remainingTicks -= 1;
      if (status.remainingTicks > 0) {
        kept.push(status);
      } else if (status.revealsBeforeExpiry && !status.revealed) {
        // Two-phase status (Love's "Love Galore"): the stealth window ran out
        // without the healing threshold being crossed — reveal now and restart
        // for a fresh, fully-visible window of the same length.
        status.revealed = true;
        status.remainingTicks = status.initialDurationTicks ?? 1;
        kept.push(status);
        if (bus.enabled) {
          bus.emit({ type: "statusRevealed", tick: state.tick, playerId: player.id, statusId: status.id });
        }
      } else {
        removed.push({ playerId: player.id, status });
        expired.push(status);
        removeModifiersFromSource(player, statusModifierSource(status.id));
        // Gameplay event (#204): the status ran out naturally.
        if (bus.enabled) {
          bus.emit({
            type: "statusExpired",
            tick: state.tick,
            playerId: player.id,
            statusId: status.id,
          });
        }
      }
    }
    player.statuses = kept;

    // Follow-up statuses on natural expiry (Epic 11, e.g. thawing from
    // Frozen briefly slows production). Applied after the reassignment so
    // the follow-up isn't wiped with the expiring batch.
    for (const status of expired) {
      // Love's Cupid's Arrow expiring: the "infatuated" kingdom's loaned
      // citizens travel home. Only the raw citizen count moves — the loan
      // never touched the price ladder, so there's nothing to unwind there.
      if (status.citizenLoanAmount) {
        const lover = state.getPlayer(status.sourceId);
        if (lover) {
          const giveBack = Math.min(status.citizenLoanAmount, lover.economy.citizens);
          if (giveBack > 0) {
            lover.economy.citizens -= giveBack;
            player.economy.citizens += giveBack;
            recalcIncome(lover);
            recalcIncome(player);
            if (bus.enabled) {
              bus.emit({
                type: "resourceTransfer",
                tick: state.tick,
                fromId: lover.id,
                toId: player.id,
                resource: "citizens",
                amount: giveBack,
                cause: "infatuated",
              });
            }
          }
        }
      }
      // Space's Supernova lock expiring: return the bearer to the target they
      // had before they were forced onto the victim (#redirect).
      if (status.blocksTargetChange && status.restoreTargetId !== undefined) {
        player.target = status.restoreTargetId;
        if (bus.enabled && status.restoreTargetId !== null) {
          bus.emit({
            type: "targetChanged",
            tick: state.tick,
            playerId: player.id,
            targetId: status.restoreTargetId,
          });
        }
      }
      if (status.onExpireStatus) {
        const inst = applyStatus(player, status.onExpireStatus.status, {
          sourceId: status.sourceId,
          durationTicks: status.onExpireStatus.durationTicks,
        });
        if (bus.enabled) {
          bus.emit({
            type: "statusApplied",
            tick: state.tick,
            targetId: player.id,
            sourceId: status.sourceId,
            statusId: inst.id,
            durationTicks: inst.remainingTicks,
            stacks: inst.stacks,
          });
        }
      }
    }
  }
  return removed;
}

/**
 * Executes every active status's recurring per-tick effects (#78): burn/poison
 * damage (through the shared shield→HP application, so death detection sees
 * DoT kills), regeneration heals capped at max HP, with optional per-stack
 * scaling. Run once per tick, before durations advance.
 */
export function processStatusTicks(
  state: GameState,
  rng: () => number = Math.random,
): void {
  const bus = state.events;
  for (const player of state.getPlayers()) {
    if (player.eliminated) continue;
    for (const status of player.statuses) {
      // Advance the status's own tick counter once per game tick, for
      // interval-cadence effects (e.g. Father Time's once-per-second punish).
      const elapsed = (status.tickElapsed = (status.tickElapsed ?? 0) + 1);
      for (const effect of status.tickEffects ?? []) {
        // Interval cadence: fire only on this effect's Nth tick (default every).
        const interval = effect.intervalTicks ?? 1;
        if (interval > 1 && elapsed % interval !== 0) continue;

        // Idle gate (Father Time): the tick is avoided if the bearer landed a
        // damaging attack since the last evaluation — measured over the window
        // that just closed — and the countdown resets for the next window.
        if (effect.onlyIfBearerIdleSinceLastTick) {
          const windowStart = status.lastIdleEvalTick ?? state.tick - interval;
          const dealtDamage = player.lastDamageDealtTick > windowStart;
          status.lastIdleEvalTick = state.tick;
          if (dealtDamage) {
            // Interrupted — the victim bought back a second. No damage.
            if (bus.enabled) {
              bus.emit({
                type: "statusTick",
                tick: state.tick,
                playerId: player.id,
                statusId: status.id,
                interrupted: true,
              });
            }
            continue;
          }
        }

        if (effect.chance !== undefined && rng() >= effect.chance) {
          continue;
        }
        // Half-life step: past the midpoint of its duration, the effect can
        // switch to a heavier magnitude (Father Time: 100 → 200 in the back
        // half). Measured from the elapsed clock vs the applied duration.
        const pastHalfLife =
          effect.amountAfterHalfLife !== undefined &&
          status.initialDurationTicks !== undefined &&
          elapsed * 2 > status.initialDurationTicks;
        const perTickAmount = pastHalfLife
          ? effect.amountAfterHalfLife!
          : effect.amount;
        let stacked = effect.perStack
          ? perTickAmount * status.stacks
          : perTickAmount;
        // Ramp: DoTs that worsen the longer they fester (Nature's Poison vs
        // Fire's flat Burn) — ×(1 + rampPerSecond × secondsActive), capped.
        if (effect.rampPerSecond) {
          const seconds = elapsed / param("tick.rate", TICK.RATE);
          const rampMult = Math.min(
            effect.rampMaxMultiplier ?? Number.POSITIVE_INFINITY,
            1 + effect.rampPerSecond * seconds,
          );
          stacked *= rampMult;
        }
        // Balance knob (ticket #202): a DoT's per-tick DAMAGE is tunable through
        // `status.<id>.tickDamage` (a multiplier, so all severity variants —
        // e.g. weak/strong Poison — scale together and keep their ratio). Reads
        // through on the null-set fast path, so the live game pays nothing.
        const base =
          effect.type === "damage"
            ? stacked * param(`status.${status.id}.tickDamage`, 1)
            : stacked;
        // DoT amplification (Epic 12): statuses on the bearer may amplify a
        // named DoT via "dotDamage:<statusId>" modifiers — e.g. Corroded
        // increasing Poison damage. Kingdom DoT-resistance passives (Water's
        // "Fountain of Youth") then cut damage from named DoTs by their pct.
        // Perks apply here too, since a DoT tick never passes through
        // `resolveDamage`: "Extra Medics" cuts damage-over-time specifically,
        // and "Extra Guards" cuts all incoming damage — both, if both are held.
        const amount = Math.round(
          computeStat(player, `dotDamage:${status.id}`, base) *
            (effect.type === "damage"
              ? dotResistanceMultiplier(player, status.id) *
                perkDotDamageTakenMultiplier(player) *
                perkDamageTakenMultiplier(player)
              : 1),
        );
        if (effect.type === "damage") {
          const applied = applyDamage(player, amount, {
            ignoreShields: effect.ignoreShields,
            tick: state.tick,
          });
          // Attribute this DoT tick back to the attack that applied the status,
          // so Blip's undo refunds status-based damage too (if still journaled).
          if (status.journalId) {
            const rec = player.attackJournal.find((r) => r.id === status.journalId);
            if (rec) {
              rec.hpRefund += applied.dealtToHp;
              rec.shieldRefund += applied.absorbedByShield;
            }
          }
          // Gameplay event (#204): DoT damage, attributed to its status.
          if (bus.enabled) {
            bus.emit({
              type: "damage",
              tick: state.tick,
              sourceId: status.sourceId,
              targetId: player.id,
              amount: applied.absorbedByShield + applied.dealtToHp,
              absorbedByShield: applied.absorbedByShield,
              dealtToHp: applied.dealtToHp,
              overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
              crit: false,
              cause: `status:${status.id}`,
            });
            if (applied.absorbedByShield > 0 && player.castle.shield <= 0) {
              bus.emit({
                type: "shieldDestroyed",
                tick: state.tick,
                playerId: player.id,
                cause: `status:${status.id}`,
              });
            }
          }
          // Love's "BFFS!!!" link: DoT damage on a linked castle also lands
          // on its partner (single hop — the partner's own link never
          // re-triggers from this direct applyDamage call).
          const link = player.statuses.find((s) => s.linkedPartnerId);
          if (link) {
            const partner = state.getPlayer(link.linkedPartnerId!);
            if (partner && !partner.eliminated) {
              const mirrored = applyDamage(partner, amount, { tick: state.tick });
              if (bus.enabled) {
                bus.emit({
                  type: "damage",
                  tick: state.tick,
                  sourceId: status.sourceId,
                  targetId: partner.id,
                  amount: mirrored.absorbedByShield + mirrored.dealtToHp,
                  absorbedByShield: mirrored.absorbedByShield,
                  dealtToHp: mirrored.dealtToHp,
                  overkill: mirrored.incoming - mirrored.absorbedByShield - mirrored.dealtToHp,
                  crit: false,
                  cause: `linked:status:${status.id}`,
                });
              }
            }
          }
        } else {
          const before = player.castle.hp;
          const requested = Math.max(0, amount);
          player.castle.hp = Math.min(
            player.castle.maxHp,
            player.castle.hp + requested,
          );
          const healed = player.castle.hp - before;
          if (healed > 0 && bus.enabled) {
            bus.emit({
              type: "heal",
              tick: state.tick,
              targetId: player.id,
              amount: healed,
              overheal: requested - healed,
              cause: `status:${status.id}`,
            });
          }
        }
      }
    }
  }
}
