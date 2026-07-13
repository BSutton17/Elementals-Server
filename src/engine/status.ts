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
import { statusDurationMultiplier } from "./passives.js";
import { param } from "./parameters.js";

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
      blocksTargetingSource: definition.blocksTargetingSource,
      deflectsAttackOnSource: definition.deflectsAttackOnSource
        ? { ...definition.deflectsAttackOnSource }
        : undefined,
      blocksAttacks: definition.blocksAttacks,
      guaranteesChanceEffects: definition.guaranteesChanceEffects,
      onExpireStatus: definition.onExpireStatus,
      blocksPurchases: definition.blocksPurchases,
      onHitRetaliate: definition.onHitRetaliate,
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

/** Prunes statuses whose modifiers have been fully consumed. */
export function pruneExhaustedStatuses(player: PlayerState): void {
  const keptStatuses: StatusEffectInstance[] = [];
  for (const s of player.statuses) {
    if (s.hasModifiers) {
      const hasActiveMod = player.modifiers.some((m) => m.sourceId === statusModifierSource(s.id));
      if (!hasActiveMod) {
        removeModifiersFromSource(player, statusModifierSource(s.id));
        continue;
      }
    }
    keptStatuses.push(s);
  }
  player.statuses = keptStatuses;
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
    pruneExhaustedStatuses(player);

    const kept: StatusEffectInstance[] = [];
    const expired: StatusEffectInstance[] = [];
    for (const status of player.statuses) {
      status.remainingTicks -= 1;
      if (status.remainingTicks > 0) {
        kept.push(status);
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
      for (const effect of status.tickEffects ?? []) {
        if (effect.chance !== undefined && rng() >= effect.chance) {
          continue;
        }
        const stacked = effect.perStack
          ? effect.amount * status.stacks
          : effect.amount;
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
        // increasing Poison damage.
        const amount = Math.round(
          computeStat(player, `dotDamage:${status.id}`, base),
        );
        if (effect.type === "damage") {
          const applied = applyDamage(player, amount, {
            ignoreShields: effect.ignoreShields,
          });
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
