import type { Match } from "../match/Match.js";
import type { ModifierOp, PlayerState } from "../match/playerState.js";
import { canAfford, spend } from "./money.js";
import { validateTransaction, type TransactionResult } from "./transactions.js";
import { isReady, setCooldown } from "./cooldowns.js";
import { addModifier, removeModifier, getTargetingRedirect, computeStat } from "./modifiers.js";
import {
  applyStatus,
  hasStatus,
  removeStatus,
  pruneExhaustedStatuses,
  isTargetingBlocked,
  type StatusEffectDefinition,
} from "./status.js";
import { resolveDamage } from "./damage.js";
import {
  canMultiTargetAttacks,
  multiTargetLimit,
  attackRedirectChance,
  shieldOnDamageDealt,
  attackCooldownMultiplier,
  attackAftershock,
  onHitStatuses,
  retaliations,
  thornsProcs,
} from "./passives.js";
import { applyDamage, type DamageApplication } from "./combat.js";
import { getActiveParameterSet, param } from "./parameters.js";
import { recalcIncome } from "./economy.js";
import { type EffectCondition, evaluateCondition } from "./conditions.js";
import { ALL_ABILITIES } from "../data/abilitiesRegistry.js";

/**
 * The shared ability framework (tickets #71–#73), per ABILITY_SYSTEM.md: one
 * engine executes *every* kingdom's abilities. There is no ability class
 * hierarchy — an ability is **data** (`AbilityDefinition`) composing generic
 * effect primitives, and this module provides the common behavior all kinds
 * (attack, utility, ultimate, passive) inherit: validation, cost & cooldown
 * processing, target resolution, and effect execution.
 *
 * Activation pipeline (#72), in the hard-contract order of ARCHITECTURE.md §7 —
 * all validation completes before anything is spent or mutated (fail closed &
 * atomic), which is exactly the #73 guarantee: money is deducted only after an
 * activation is certain to succeed.
 */

export type AbilityKind = "attack" | "utility" | "ultimate" | "passive";

export type TargetingMode = "self" | "singleEnemy" | "allEnemies" | "noTarget";

/** One generic effect primitive; the engine applies each in order. */
export interface EffectDefinition {
  type:
    | "damage"
    | "heal"
    | "shield"
    | "status"
    | "buff"
    | "debuff"
    | "economyModifier"
    | "resourceTransfer"
    | "cooldownModify"
    | "vision";
  /** Who this effect applies to within the resolved targeting.
   *  `otherEnemies` = every living enemy *except* the resolved target
   *  (Earthquake's aftershock, Epic 9 — "adjacent" until maps land). */
  target: "self" | "target" | "otherEnemies";
  /** Conditional effects (ticket #101). */
  conditions?: EffectCondition[];
  /** Probability check (ticket #102). */
  chance?: number;
  params: {
    /** damage/heal/shield magnitude. */
    amount?: number;
    /** heal: additionally restore this fraction of the recipient's max HP. */
    percentMaxHp?: number;
    /** damage: bypass the target's shield pool. */
    ignoreShields?: boolean;
    /** damage: the attack's element (consumed by resistances/matchups). */
    element?: string;
    /** damage: elemental interaction multiplier (from matchup data). */
    elementMultiplier?: number;
    /** damage: bonus multiplier against shielded targets (Meteor Shower). */
    shieldDamageMultiplier?: number;
    /** damage: excess shield-bonus damage carries into castle HP instead of
     *  capping at the shield (Meteor Shower Lv 5). */
    shieldDamageOverflow?: boolean;
    /**
     * damage: heal the caster for `ratio` × damage dealt, optionally only
     * while the target bears a named status (e.g. Water healing vs Current).
     */
    lifesteal?: { ratio: number; requiresTargetStatus?: string };
    /** status: definition + duration. */
    status?: StatusEffectDefinition;
    durationTicks?: number;
    stacks?: number;
    /**
     * status: extra duration when the recipient already bears a named status
     * (e.g. Flood lasting longer against Current-affected targets).
     */
    bonusDurationIfTargetHasStatus?: { statusId: string; extraTicks: number };
    /** buff/debuff: the modifier to add. */
    stat?: string;
    op?: ModifierOp;
    value?: number;
    /** buff/debuff: duration in ticks (null/omitted = permanent). */
    modifierTicks?: number | null;
    /** economyModifier: citizen adjustments (percent is of current count). */
    citizensPercent?: number;
    citizensFlat?: number;
    /** damage: extra damage when the recipient bears a named status. */
    bonusDamageIfTargetHasStatus?: { statusId: string; extraAmount: number };
    /** resourceTransfer: transfer currency/citizens from recipient to caster (ticket #106) */
    resourceTransfer?: {
      type: "currency" | "citizens";
      amount?: number;
      percent?: number;
    };
    /** cooldownModify: alter existing cooldown duration of recipient's abilities (ticket #107) */
    cooldownModify?: {
      op: "set" | "add" | "multiply";
      value: number;
      target: "all" | "attacks" | "utilities" | "ultimates" | string;
    };
    /** vision: apply temporary vision status effects (ticket #108) */
    vision?: {
      type: "fog" | "hiddenInventory" | "overlay" | string;
      durationTicks: number;
    };
  };
}

/**
 * One purchasable upgrade tier (ticket #75, ABILITY_SYSTEM.md §7). Tiers are
 * ordered data overrides merged onto the base definition — an upgrade never
 * forks behavior, it parameterizes it, so *any* property expressed in ability
 * data (damage amounts, cooldowns, durations, costs, visual-effect keys, …) is
 * upgradeable with zero engine or kingdom-specific changes.
 */
export interface UpgradeTier {
  /** Tier index, 1-based (level 0 = the base definition). */
  level: number;
  /** Currency cost to purchase this tier. */
  cost: number;
  changes: {
    /** Overrides the activation cost. */
    cost?: number;
    /** Scales the activation cost, rounded down (e.g. 0.85 = 15% cheaper).
     *  Every cooldown-reduction tier also carries one of these. */
    costMultiplier?: number;
    /** Overrides the cooldown. */
    cooldownTicks?: number;
    /**
     * Per-effect param overrides, matched to `effects` by index; null/omitted
     * entries leave that effect untouched. Merged shallowly, so a tier can bump
     * `amount`, extend `durationTicks`, swap a visual key, etc.
     */
    effectParams?: (Partial<EffectDefinition["params"]> | null)[];
    /** Overrides the chance of effects, matched by index. */
    effectChances?: (number | null)[];
    /** Additional effects unlocked at this tier. */
    addEffects?: EffectDefinition[];
    /** Partial overrides of the charge system (e.g. faster recharge). */
    chargeSystem?: Partial<ChargeSystem>;
    /** Overrides the concurrent-affected cap (e.g. Thick Fog Lv 5: 3 → 4). */
    maxConcurrentAffected?: { statusId: string; limit: number };
    /**
     * Permanent stat modifiers granted to the player when this tier is
     * purchased (Epic 10, e.g. Lightning Barrage extending charge duration
     * via `buffDuration:<stat>`). Applied by purchaseUpgrade, never expire.
     */
    permanentModifiers?: { stat: string; op: ModifierOp; value: number }[];
  };
}

/**
 * Charge-based casting (Lightning Barrage, Epic 10). The ability owns a pool
 * of `max` charges; each cast spends 1..max of them (the caster chooses via
 * ActivateOptions.chargesToUse) and costs `costPerCharge` gold per charge.
 * Total damage comes from `damageByCharges` indexed by charges spent
 * (e.g. [200, 410, 650]). Spent charges regenerate independently: spending k
 * charges arms staggered countdowns of 1×, 2×, … k× `rechargeTicks`, so
 * remaining charges stay castable immediately.
 */
export interface ChargeSystem {
  max: number;
  rechargeTicks: number;
  costPerCharge: number;
  damageByCharges: number[];
}

/** The data an ability *is*. Kingdom ability sets are lists of these. */
export interface AbilityDefinition {
  id: string;
  /** Human-readable display name (optional; for UI). */
  name?: string;
  kind: AbilityKind;
  /** Money cost to activate (0 for free/passive). */
  cost: number;
  /** Explicit unlock price; when omitted, unlocking costs 50% of `cost`. */
  unlockCost?: number;
  /** Cooldown started on successful activation (0 = none). */
  cooldownTicks: number;
  targeting: { mode: TargetingMode };
  effects: EffectDefinition[];
  /** Charge-based casting (Lightning Barrage); see ChargeSystem. */
  chargeSystem?: ChargeSystem;
  /**
   * Caps how many players may simultaneously bear `statusId` applied by this
   * caster (Air's Thick Fog, Epic 8). Activating on a fresh target while the
   * cap is full fails with TARGET_LIMIT — nothing is spent, no cooldown armed.
   */
  maxConcurrentAffected?: { statusId: string; limit: number };
  /** Ordered upgrade tiers (ticket #75); omitted = not upgradeable. */
  upgradePath?: UpgradeTier[];
}

/** The player's current upgrade level for an ability (0 = base). */
export function getUpgradeLevel(player: PlayerState, abilityId: string): number {
  return player.upgrades[abilityId] ?? 0;
}

/**
 * Resolves the *effective* definition at an upgrade level by merging the
 * `changes` of every tier up to `level` onto the base, in order (#75). The
 * base definition is never mutated (definitions are immutable at runtime).
 */
export function resolveAbility(
  ability: AbilityDefinition,
  level: number,
): AbilityDefinition {
  const resolved: AbilityDefinition = {
    ...ability,
    effects: ability.effects.map((e) => ({ ...e, params: { ...e.params } })),
  };
  applyParameterOverrides(resolved);
  for (const tier of ability.upgradePath ?? []) {
    if (tier.level > level) continue;
    if (tier.changes.cost !== undefined) resolved.cost = tier.changes.cost;
    if (tier.changes.costMultiplier !== undefined) {
      resolved.cost = Math.floor(resolved.cost * tier.changes.costMultiplier);
    }
    if (tier.changes.cooldownTicks !== undefined) {
      resolved.cooldownTicks = tier.changes.cooldownTicks;
    }
    if (tier.changes.maxConcurrentAffected !== undefined) {
      resolved.maxConcurrentAffected = tier.changes.maxConcurrentAffected;
    }
    tier.changes.effectParams?.forEach((params, i) => {
      if (params && resolved.effects[i]) {
        Object.assign(resolved.effects[i].params, params);
      }
    });
    tier.changes.effectChances?.forEach((chance, i) => {
      if (chance !== null && chance !== undefined && resolved.effects[i]) {
        resolved.effects[i].chance = chance;
      }
    });
    for (const extra of tier.changes.addEffects ?? []) {
      resolved.effects.push({ ...extra, params: { ...extra.params } });
    }
    if (tier.changes.chargeSystem && resolved.chargeSystem) {
      resolved.chargeSystem = {
        ...resolved.chargeSystem,
        ...tier.changes.chargeSystem,
      };
    }
  }
  return resolved;
}

/**
 * Applies active balance-parameter overrides (ticket #202) to a fresh
 * per-activation copy of an ability, BEFORE upgrade tiers merge — so a
 * candidate configuration retunes base values while upgrade scaling still
 * layers on top. No active set (the live game) means no work and no change.
 *
 * Ids mirror parameterCatalog.ts exactly:
 *   ability.<id>.cost / .cooldownTicks / .charge.<field> /
 *   .charge.damage.<i> / .effects.<i>.<numericKey> / .effects.<i>.chance
 */
function applyParameterOverrides(resolved: AbilityDefinition): void {
  if (getActiveParameterSet() === null) return; // production: zero overhead

  const id = resolved.id;
  resolved.cost = param(`ability.${id}.cost`, resolved.cost);
  resolved.cooldownTicks = param(
    `ability.${id}.cooldownTicks`,
    resolved.cooldownTicks,
  );

  if (resolved.chargeSystem) {
    const c = resolved.chargeSystem;
    resolved.chargeSystem = {
      max: Math.round(param(`ability.${id}.charge.max`, c.max)),
      rechargeTicks: Math.round(
        param(`ability.${id}.charge.rechargeTicks`, c.rechargeTicks),
      ),
      costPerCharge: param(`ability.${id}.charge.costPerCharge`, c.costPerCharge),
      damageByCharges: c.damageByCharges.map((dmg, i) =>
        param(`ability.${id}.charge.damage.${i}`, dmg),
      ),
    };
  }

  resolved.effects.forEach((effect, i) => {
    if (effect.chance !== undefined) {
      effect.chance = param(`ability.${id}.effects.${i}.chance`, effect.chance);
    }
    for (const key of Object.keys(effect.params)) {
      const value = (effect.params as Record<string, unknown>)[key];
      if (typeof value === "number") {
        (effect.params as Record<string, number>)[key] = param(
          `ability.${id}.effects.${i}.${key}`,
          value,
        );
      }
    }
  });
}

/**
 * Purchases the caster's next upgrade tier for an ability (#75). Validated
 * through the shared transaction system; on success the cost is spent and the
 * player's level increments. Applies from the *next* activation — an already
 * armed cooldown is not retroactively changed.
 */
export function purchaseUpgrade(
  match: Match,
  player: PlayerState,
  ability: AbilityDefinition,
): TransactionResult & { level?: number } {
  const current = getUpgradeLevel(player, ability.id);
  const next = (ability.upgradePath ?? []).find((t) => t.level === current + 1);
  if (!next) return { ok: false, error: "INVALID_TRANSACTION" }; // maxed / none

  const tierCost = param(
    `ability.${ability.id}.upgrade.${next.level}.cost`,
    next.cost,
  );
  const validation = validateTransaction(match, player, tierCost);
  if (!validation.ok) return validation;

  spend(player, tierCost);
  player.upgrades[ability.id] = current + 1;

  // Gameplay event (#204).
  const upgradeBus = match.gameState?.events;
  if (upgradeBus?.enabled) {
    upgradeBus.emit({ type: "purchase", tick: match.tick, playerId: player.id, kind: "upgrade", itemId: ability.id, cost: tierCost });
  }

  // Permanent stat grants attached to this tier (Epic 10).
  for (const [i, spec] of (next.changes.permanentModifiers ?? []).entries()) {
    addModifier(player, {
      id: `upgrade:${ability.id}:${next.level}:${i}`,
      stat: spec.stat,
      op: spec.op,
      value: spec.value,
      sourceId: `upgrade:${ability.id}`,
      remainingTicks: null,
    });
  }
  return { ok: true, level: current + 1 };
}

export type AbilityError =
  | "INVALID_PHASE"
  | "ELIMINATED"
  | "NOT_ACTIVATABLE" // passives are trigger-driven, never manually cast
  | "ON_COOLDOWN"
  | "INSUFFICIENT_FUNDS"
  | "TARGET_REQUIRED"
  | "INVALID_TARGET"
  | "TARGET_LIMIT" // concurrent-affected cap reached (e.g. Thick Fog)
  | "ATTACKS_BLOCKED" // a crowd-control status bars attacking (e.g. Frozen)
  | "NO_CHARGES"; // a charge-costed ability needs at least one charge

export interface AbilityActivation {
  ok: boolean;
  error?: AbilityError;
  /** Damage breakdowns for any damage effects, in effect order. */
  damage?: DamageApplication[];
  /** The resolved target's id (self-casts resolve to the caster). */
  targetId?: string;
}

export interface ActivateOptions {
  /** Explicit target for singleEnemy abilities; defaults to the caster's
   * currently selected target (ticket #61). */
  targetId?: string;
  /**
   * Multiple explicit targets for one attack cast (Air's "Embrace of Winds",
   * Epic 8). Honored only when the caster's kingdom has the multiTargetAttacks
   * passive and the ability is an attack; otherwise the first id is used.
   * Cost and cooldown are paid once; every effect applies to each target.
   */
  targetIds?: string[];
  /**
   * How many charges to spend on a charge-costed cast (Lightning Barrage,
   * Epic 10). Clamped to [1, spec.max] and to the charges actually held;
   * defaults to "as many as available (up to max)".
   */
  chargesToUse?: number;
  /** Deterministic crit control for tests (see damage engine). */
  forceCrit?: boolean;
  rng?: () => number;
  /** Engine-internal (Ice's Frozen Focus, Epic 11): set by activateAbility
   *  while the caster holds guarantee stacks — chance-gated effects always
   *  proc. Not intended to be passed by callers. */
  guaranteeChances?: boolean;
}

/**
 * Activates an ability through the shared pipeline (#72):
 *   validate ability → validate phase/actor → cooldown → funds → target →
 *   spend & start cooldown (#73) → apply effects → report.
 *
 * Thin wrapper over the pipeline that publishes a `castFailed` event (#204) on
 * any rejection — telemetry consumers use it to measure wasted intents. The
 * emission is fire-and-forget and guarded on `bus.enabled`, so it costs nothing
 * for unmonitored matches and never affects gameplay.
 */
export function activateAbility(
  match: Match,
  caster: PlayerState,
  ability: AbilityDefinition,
  options: ActivateOptions = {},
): AbilityActivation {
  const result = activateAbilityInner(match, caster, ability, options);
  if (!result.ok) {
    const bus = match.gameState?.events;
    if (bus?.enabled) {
      // Attribute a status-caused rejection to the responsible active status,
      // generically: the only cast rejection a status produces is a crowd
      // control that bars attacking, so report the caster's blocking status.
      const statusId =
        result.error === "ATTACKS_BLOCKED"
          ? caster.statuses.find((s) => s.blocksAttacks)?.id
          : undefined;
      bus.emit({
        type: "castFailed",
        tick: match.tick,
        casterId: caster.id,
        abilityId: ability.id,
        reason: result.error ?? "UNKNOWN",
        statusId,
      });
    }
  }
  return result;
}

function activateAbilityInner(
  match: Match,
  caster: PlayerState,
  ability: AbilityDefinition,
  options: ActivateOptions = {},
): AbilityActivation {
  // 1. Validate the ability is manually usable at all.
  if (ability.kind === "passive") return { ok: false, error: "NOT_ACTIVATABLE" };

  // Resolve the effective definition at the caster's upgrade level (#75):
  // cost, cooldown, and effect params below all come from this.
  const effective = resolveAbility(ability, getUpgradeLevel(caster, ability.id));

  // #203: every gameplay dice roll flows through the match-level RNG unless
  // a caller (deterministic tests) pins its own stream explicitly.
  if (options.rng === undefined) {
    options = { ...options, rng: match.rng };
  }

  // 2. Validate phase and actor.
  if (match.phase !== "active") return { ok: false, error: "INVALID_PHASE" };
  if (caster.eliminated) return { ok: false, error: "ELIMINATED" };

  // Frozen-style attack bans (Epic 11): crowd-control statuses that stop the
  // bearer from attacking (Ice's Frozen, Blizzard). Non-attacks stay legal.
  if (ability.kind === "attack" && caster.statuses.some((s) => s.blocksAttacks)) {
    return { ok: false, error: "ATTACKS_BLOCKED" };
  }

  // 3. Validate cooldown, then funds. Charge-based abilities (Lightning
  // Barrage) price the cast per charge spent: the caster picks 1..max charges
  // (default 1), clamped to how many are currently regenerated. The cast's
  // damage comes from the per-count table; spent charges regenerate on
  // independent staggered timers (armed after the spend, step 5).
  if (!isReady(caster, effective.id)) return { ok: false, error: "ON_COOLDOWN" };

  const chargeSystem = effective.chargeSystem;
  let castCost = effective.cost;
  let chargesPlanned: number | undefined;
  if (chargeSystem) {
    const recharging = caster.recharges[effective.id]?.length ?? 0;
    const available = Math.max(0, chargeSystem.max - recharging);
    if (available === 0) return { ok: false, error: "NO_CHARGES" };
    const requested = Math.max(
      1,
      Math.min(chargeSystem.max, Math.floor(options.chargesToUse ?? 1)),
    );
    chargesPlanned = Math.min(requested, available);
    castCost = chargeSystem.costPerCharge * chargesPlanned;

    // Damage scales with charges spent: add the table value for this cast.
    // `effective` is a per-activation copy, so this never leaks between casts.
    const dmgEffect = effective.effects.find((e) => e.type === "damage");
    if (dmgEffect) {
      const idx = Math.min(chargesPlanned, chargeSystem.damageByCharges.length) - 1;
      dmgEffect.params.amount =
        (dmgEffect.params.amount ?? 0) + (chargeSystem.damageByCharges[idx] ?? 0);
    }
  }

  // Price modifiers: statuses may scale a specific ability's price
  // ("abilityCost:<id>" — Thundering Fate quarters Zap's price) or every
  // price ("abilityCost"). Rounded down to whole gold.
  castCost = Math.max(
    0,
    Math.floor(
      computeStat(
        caster,
        `abilityCost:${effective.id}`,
        computeStat(caster, "abilityCost", castCost),
      ),
    ),
  );

  if (!canAfford(caster, castCost)) {
    return { ok: false, error: "INSUFFICIENT_FUNDS" };
  }

  // 4. Resolve targeting (ABILITY_SYSTEM.md §4).
  const rng = options.rng!;
  /** Valid deflection/redirect destinations: anyone alive except `excludeId`
   *  — which deliberately *includes* the attacker (Air, Epic 8). */
  const otherPlayers = (excludeId: string): PlayerState[] =>
    match.gameState!.getPlayers().filter(
      (p) => !p.eliminated && p.id !== excludeId,
    );

  let targets: PlayerState[];
  switch (effective.targeting.mode) {
    case "self":
    case "noTarget":
      targets = [caster];
      break;
    case "allEnemies":
      // Every living enemy; status-imposed targeting bans (#88) still bind.
      targets = match.gameState!.getPlayers().filter(
        (p) =>
          p.id !== caster.id &&
          !p.eliminated &&
          !isTargetingBlocked(caster, p.id),
      );
      if (targets.length === 0) return { ok: false, error: "INVALID_TARGET" };
      break;
    case "singleEnemy": {
      // Multi-target casts (Air's "Embrace of Winds", Epic 8): honored only
      // for attacks from kingdoms with the multiTargetAttacks passive.
      const requestedIds =
        options.targetIds && options.targetIds.length > 0
          ? ability.kind === "attack" && canMultiTargetAttacks(caster)
            ? // Embrace of Winds cap: at most maxTargets kingdoms (3 base, 5
              // upgraded) may be struck by one cast.
              [...new Set(options.targetIds)].slice(0, multiTargetLimit(caster))
            : [options.targetIds[0]!]
          : [options.targetId ?? caster.target];

      targets = [];
      for (const targetId of requestedIds) {
        if (!targetId) return { ok: false, error: "TARGET_REQUIRED" };
        if (targetId === caster.id) return { ok: false, error: "INVALID_TARGET" };
        const resolved = match.hasPlayer(targetId)
          ? match.gameState?.getPlayer(targetId)
          : undefined;
        if (!resolved || resolved.eliminated) {
          return { ok: false, error: "INVALID_TARGET" };
        }
        // Status-imposed targeting bans (#88) bind ability casts too.
        if (isTargetingBlocked(caster, targetId)) {
          return { ok: false, error: "INVALID_TARGET" };
        }
        let target = resolved;

        // Apply targeting redirection (ticket #109)
        const redirectId = getTargetingRedirect(target, caster);
        if (redirectId && redirectId !== target.id) {
          const redirected = match.gameState?.getPlayer(redirectId);
          if (redirected && !redirected.eliminated && !isTargetingBlocked(caster, redirected.id)) {
            target = redirected;
          }
        }

        // Hurricane-style deflection (Air, Epic 8): a mark on the *caster*,
        // applied by the resolved target, deflects this attack to another
        // valid kingdom — possibly back onto the caster. Consumed on use.
        const mark = caster.statuses.find(
          (s) => s.deflectsAttackOnSource && s.sourceId === target.id,
        );
        if (mark) {
          const destinations = otherPlayers(target.id);
          if (destinations.length > 0) {
            target = destinations[Math.floor(rng() * destinations.length)]!;
            // Hurricane Lv 3: the deflected attack hits the redirected target
            // harder — a one-use damage multiplier on this activation.
            const mult = mark.deflectsAttackOnSource!.damageMult;
            if (mult) {
              addModifier(caster, {
                id: `deflect:${mark.id}:${match.tick}:${match.nextSeq()}`,
                stat: "damage",
                op: "mult",
                value: mult,
                sourceId: `deflect:${mark.sourceId}`,
                remainingTicks: null,
                usageLimit: 1,
              });
            }
            // Hurricane Lv 5: one roll to keep the mark for a second
            // deflection (1 becomes 2, never more).
            const chain = mark.deflectsAttackOnSource!.chainChance ?? 0;
            if (!mark.deflectionChained && chain > 0 && rng() < chain) {
              mark.deflectionChained = true;
            } else {
              removeStatus(caster, mark.id);
            }
          }
        }

        // A Gust of Envy (Air passive, Epic 8): attacks on this kingdom have
        // a chance to be redirected to another kingdom — attacker included.
        const redirectPct = attackRedirectChance(target);
        if (redirectPct > 0 && rng() < redirectPct) {
          const destinations = otherPlayers(target.id);
          if (destinations.length > 0) {
            target = destinations[Math.floor(rng() * destinations.length)]!;
          }
        }

        targets.push(target);
      }
      break;
    }
  }

  // 4b. Concurrent-affected cap (Air's Thick Fog, Epic 8): fail closed while
  // the cap is full — a re-cast on an already-affected target stays legal.
  if (effective.maxConcurrentAffected) {
    const { statusId, limit } = effective.maxConcurrentAffected;
    const bearers = match.gameState!.getPlayers().filter((p) =>
      p.statuses.some((s) => s.id === statusId && s.sourceId === caster.id),
    );
    const fresh = targets.filter(
      (t) => !bearers.some((b) => b.id === t.id),
    );
    if (bearers.length + fresh.length > limit) {
      return { ok: false, error: "TARGET_LIMIT" };
    }
  }

  // 5. All validation passed — only now spend, and arm the cooldown
  // immediately, before any effect resolves (#73, #74). Effects can never run
  // twice off one activation, even if effect execution itself re-enters.
  // Attack cooldowns honor kingdom passives (Electricity's "Don't Blink",
  // Epic 10); setCooldown then applies cooldown modifier stats (#107).
  spend(caster, castCost);
  const cooldownTicks =
    ability.kind === "attack"
      ? Math.round(effective.cooldownTicks * attackCooldownMultiplier(caster))
      : effective.cooldownTicks;
  setCooldown(caster, effective.id, cooldownTicks);

  // Arm charge regeneration: spending k charges starts staggered independent
  // countdowns (1×, 2×, … k× rechargeTicks), so one charge returns every
  // rechargeTicks and unspent charges stay castable immediately.
  if (chargeSystem && chargesPlanned) {
    const timers = (caster.recharges[effective.id] ??= []);
    for (let i = 1; i <= chargesPlanned; i++) {
      timers.push(i * chargeSystem.rechargeTicks);
    }
  }

  // Gameplay event (#204): the cast is accepted and paid for — announce it.
  const castBus = match.gameState!.events;
  if (castBus.enabled) {
    castBus.emit({
      type: "abilityCast",
      tick: match.tick,
      casterId: caster.id,
      abilityId: effective.id,
      targetIds: targets.map((t) => t.id),
      cost: castCost,
      chargesUsed: chargesPlanned,
    });
  }

  // 6. Apply each effect primitive in order, to every resolved target.
  const damage: DamageApplication[] = [];

  // Frozen Focus (Epic 11): while the caster holds guarantee stacks, an
  // attack's chance-gated effects always proc; each attack consumes a stack.
  const focus =
    ability.kind === "attack"
      ? caster.statuses.find((s) => s.guaranteesChanceEffects && s.stacks > 0)
      : undefined;
  const effectOptions = focus ? { ...options, guaranteeChances: true } : options;

  // Resolve targeting modifiers (ticket #109)
  const duplicateCount = Math.max(1, Math.round(computeStat(caster, "duplicateAttackCount", 1)));
  const extraTargetsCount = Math.max(0, Math.round(computeStat(caster, "extraTargetsCount", 0)));

  // Air's "Embrace of Winds" (Epic 8): a multi-target attack divides its
  // damage evenly across the kingdoms it strikes — a re-cast on one kingdom is
  // spread 1 (unchanged). Only the multi-target singleEnemy path can resolve
  // more than one primary target, so every other attack keeps full damage.
  // Non-damage effects (status, heal, …) still apply in full to each target.
  const damageSpread =
    effective.targeting.mode === "singleEnemy" ? Math.max(1, targets.length) : 1;

  for (let i = 0; i < duplicateCount; i++) {
    // Apply to each resolved target
    for (const target of targets) {
      for (const effect of effective.effects) {
        // Aftershock-style splash (Epic 9): this effect hits every living
        // enemy except the struck target, targeting bans respected.
        if (effect.target === "otherEnemies") {
          const others = match.gameState!.getPlayers().filter(
            (p) =>
              p.id !== caster.id &&
              p.id !== target.id &&
              !p.eliminated &&
              !isTargetingBlocked(caster, p.id),
          );
          for (const other of others) {
            applyEffect(match, effective.id, caster, other, other, effect, effectOptions, damage);
          }
          continue;
        }
        const recipient = effect.target === "self" ? caster : target;
        applyEffect(match, effective.id, caster, target, recipient, effect, effectOptions, damage, damageSpread);
      }
    }

    // Apply to extra random enemy targets (multi-target modifier)
    if (extraTargetsCount > 0 && effective.targeting.mode === "singleEnemy") {
      const otherEnemies = match.gameState!.getPlayers().filter((p) => {
        return p.id !== caster.id && !targets.some((t) => t.id === p.id) && !p.eliminated && !isTargetingBlocked(caster, p.id);
      });
      const chosenEnemies = otherEnemies.slice(0, extraTargetsCount);
      for (const extraTarget of chosenEnemies) {
        for (const effect of effective.effects) {
          // Splash effects already covered every other enemy above.
          if (effect.target === "otherEnemies") continue;
          const recipient = effect.target === "self" ? caster : extraTarget;
          applyEffect(match, effective.id, caster, extraTarget, recipient, effect, effectOptions, damage);
        }
      }
    }
  }

  // One guarantee stack is spent per attack (Frozen Focus, Epic 11).
  if (focus) {
    focus.stacks -= 1;
    if (focus.stacks <= 0) removeStatus(caster, focus.id);
  }

  // Clean up any statuses that are now exhausted (modifiers consumed), e.g.
  // Blazing Determination once its buffed strike lands. Report each as expired
  // so VFX/replays learn the buff ended by being USED, not by timing out.
  const pruneBus = match.gameState!.events;
  const emitExpired = (playerId: string, exhausted: ReturnType<typeof pruneExhaustedStatuses>) => {
    if (!pruneBus.enabled) return;
    for (const s of exhausted) {
      pruneBus.emit({ type: "statusExpired", tick: match.tick, playerId, statusId: s.id });
    }
  };
  emitExpired(caster.id, pruneExhaustedStatuses(caster));
  for (const target of targets) emitExpired(target.id, pruneExhaustedStatuses(target));

  return { ok: true, damage, targetId: targets[0]!.id };
}

/** Executes one effect primitive on its recipient. `damageSpread` divides a
 *  damage effect's base amount across a multi-target attack's kingdoms (Air,
 *  Epic 8); it defaults to 1 and only affects the `damage` effect type. */
function applyEffect(
  match: Match,
  abilityId: string,
  caster: PlayerState,
  target: PlayerState,
  recipient: PlayerState,
  effect: EffectDefinition,
  options: ActivateOptions,
  damage: DamageApplication[],
  damageSpread = 1,
): void {
  // Check condition validations (ticket #101)
  if (effect.conditions) {
    const allMet = effect.conditions.every((c) =>
      evaluateCondition(c, caster, target),
    );
    if (!allMet) return;
  }

  // Check chance probability (ticket #102); Frozen Focus guarantees skip the
  // roll entirely (Epic 11).
  if (effect.chance !== undefined && !options.guaranteeChances) {
    const rng = options.rng ?? match.rng;
    if (rng() >= effect.chance) return;
  }

  const p = effect.params;
  // Gameplay events (#204). Emissions are fire-and-forget and guarded on
  // bus.enabled so unmonitored matches allocate nothing here.
  const bus = match.gameState!.events;
  const emitDamage = (
    targetId: string,
    sourceId: string,
    applied: DamageApplication,
    crit: boolean,
    cause: string,
  ): void => {
    if (!bus.enabled) return;
    bus.emit({
      type: "damage",
      tick: match.tick,
      sourceId,
      targetId,
      amount: applied.absorbedByShield + applied.dealtToHp,
      absorbedByShield: applied.absorbedByShield,
      dealtToHp: applied.dealtToHp,
      overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
      crit,
      element: p.element,
      cause,
    });
    const bearer = match.gameState!.getPlayer(targetId);
    if (applied.absorbedByShield > 0 && bearer && bearer.castle.shield <= 0) {
      bus.emit({ type: "shieldDestroyed", tick: match.tick, playerId: targetId, cause });
    }
  };
  const emitStatusApplied = (
    targetId: string,
    sourceId: string,
    instance: { id: string; remainingTicks: number; stacks: number },
  ): void => {
    if (!bus.enabled) return;
    bus.emit({
      type: "statusApplied",
      tick: match.tick,
      targetId,
      sourceId,
      statusId: instance.id,
      durationTicks: instance.remainingTicks,
      stacks: instance.stacks,
    });
  };
  switch (effect.type) {
    case "damage": {
      // Multi-target attacks spread their listed damage evenly across the
      // kingdoms struck (Air, Epic 8); a per-target conditional bonus applies
      // in full to whoever qualifies. resolveDamage rounds the final figure.
      let baseAmount = (p.amount ?? 0) / damageSpread;
      if (
        p.bonusDamageIfTargetHasStatus &&
        hasStatus(recipient, p.bonusDamageIfTargetHasStatus.statusId)
      ) {
        baseAmount += p.bonusDamageIfTargetHasStatus.extraAmount;
      }

      const resolved = resolveDamage(caster, recipient, baseAmount, {
        element: p.element,
        elementMultiplier: p.elementMultiplier,
        forceCrit: options.forceCrit,
        rng: options.rng,
        ignoreShields: p.ignoreShields,
        shieldDamageMultiplier: p.shieldDamageMultiplier,
        shieldDamageOverflow: p.shieldDamageOverflow,
      });
      const applied = applyDamage(recipient, resolved.amount, {
        ignoreShields: p.ignoreShields,
      });
      damage.push(applied);
      emitDamage(recipient.id, caster.id, applied, resolved.crit, abilityId);

      // Conditional lifesteal (#85): heal the caster for a ratio of the
      // damage dealt (shield + HP), gated on a target status when configured.
      const steal = p.lifesteal;
      if (
        steal &&
        (!steal.requiresTargetStatus ||
          hasStatus(recipient, steal.requiresTargetStatus))
      ) {
        const dealt = applied.absorbedByShield + applied.dealtToHp;
        const requested = Math.round(dealt * steal.ratio);
        const healed = healCastle(caster, requested);
        if (healed > 0 && bus.enabled) {
          bus.emit({ type: "heal", tick: match.tick, targetId: caster.id, amount: healed, overheal: requested - healed, cause: `lifesteal:${abilityId}` });
        }
      }

      // Distraught (Earth passive, Epic 9): dealing damage slowly rebuilds
      // the caster's shield — a fraction of the damage dealt.
      const shieldRegen = shieldOnDamageDealt(caster);
      if (shieldRegen > 0 && recipient.id !== caster.id) {
        const dealt = applied.absorbedByShield + applied.dealtToHp;
        const regen = Math.round(dealt * shieldRegen);
        caster.castle.shield += regen;
        if (regen > 0 && bus.enabled) {
          bus.emit({ type: "shieldGained", tick: match.tick, playerId: caster.id, amount: regen, total: caster.castle.shield, cause: "shieldOnDamageDealt" });
        }
      }

      // AfterShock (Electricity passive, Epic 10): attacks have a chance to
      // deal a fraction of the hit as bonus damage after hitting.
      const aftershock = attackAftershock(caster);
      if (aftershock && recipient.id !== caster.id) {
        const rng = options.rng ?? match.rng;
        if (rng() < aftershock.chance) {
          const bonus = applyDamage(
            recipient,
            Math.round(resolved.amount * aftershock.pct),
            { ignoreShields: p.ignoreShields },
          );
          damage.push(bonus);
          emitDamage(recipient.id, caster.id, bonus, false, "aftershock");
        }
      }

      // Cold Embrace / Frostbite (Ice passives, Epic 11): chance-based status
      // procs — on-hit against the victim (honors Frozen Focus guarantees)
      // and retaliation against the attacker.
      if (recipient.id !== caster.id) {
        const procRng = options.rng ?? match.rng;
        for (const proc of onHitStatuses(caster)) {
          if (options.guaranteeChances || procRng() < proc.chance) {
            const inst = applyStatus(recipient, proc.status, {
              sourceId: caster.id,
              durationTicks: proc.durationTicks,
            });
            emitStatusApplied(recipient.id, caster.id, inst);
          }
        }
        for (const proc of retaliations(recipient)) {
          if (procRng() < proc.chance) {
            const inst = applyStatus(caster, proc.status, {
              sourceId: recipient.id,
              durationTicks: proc.durationTicks,
            });
            emitStatusApplied(caster.id, recipient.id, inst);
          }
        }

        // Poison Apple-style marks (Epic 12): a status on the victim strikes
        // back with a status on the attacker, consumed on use.
        for (const mark of [...recipient.statuses]) {
          if (mark.onHitRetaliate) {
            const inst = applyStatus(caster, mark.onHitRetaliate.status, {
              sourceId: recipient.id,
              durationTicks: mark.onHitRetaliate.durationTicks,
            });
            emitStatusApplied(caster.id, recipient.id, inst);
            removeStatus(recipient, mark.id);
          }
        }

        // No Rose Without Thorns (Nature passive, Epic 12): attackers risk
        // receiving a fraction of the damage they dealt reflected back.
        for (const t of thornsProcs(recipient)) {
          if (procRng() < t.chance) {
            const dealt = applied.absorbedByShield + applied.dealtToHp;
            const reflected = applyDamage(caster, Math.round(dealt * t.pct), {});
            damage.push(reflected);
            emitDamage(caster.id, recipient.id, reflected, false, "thorns");
          }
        }
      }
      break;
    }
    case "heal": {
      const flat = p.amount ?? 0;
      const pct = p.percentMaxHp
        ? recipient.castle.maxHp * p.percentMaxHp
        : 0;
      const requested = Math.round(flat + pct);
      const healed = healCastle(recipient, requested);
      if (healed > 0 && bus.enabled) {
        bus.emit({ type: "heal", tick: match.tick, targetId: recipient.id, amount: healed, overheal: requested - healed, cause: abilityId });
      }
      break;
    }
    case "shield": {
      const granted = Math.max(0, Math.round(p.amount ?? 0));
      recipient.castle.shield += granted;
      if (granted > 0 && bus.enabled) {
        bus.emit({ type: "shieldGained", tick: match.tick, playerId: recipient.id, amount: granted, total: recipient.castle.shield, cause: abilityId });
      }
      break;
    }
    case "status":
      if (p.status) {
        // Conditional duration bonus (#86): e.g. Flood lasts longer against
        // Current-affected targets. Checked before application so an ability
        // applying the prerequisite itself must order its effects accordingly.
        const bonus = p.bonusDurationIfTargetHasStatus;
        const extra =
          bonus && hasStatus(recipient, bonus.statusId) ? bonus.extraTicks : 0;
        const inst = applyStatus(recipient, p.status, {
          sourceId: caster.id,
          durationTicks: (p.durationTicks ?? 0) + extra,
          stacks: p.stacks,
        });
        emitStatusApplied(recipient.id, caster.id, inst);
      }
      break;
    case "economyModifier": {
      // Citizen adjustments (#90): percent of the current count plus a flat
      // delta, never below zero; income refreshes immediately.
      const current = recipient.economy.citizens;
      const next = Math.max(
        0,
        Math.round(current * (1 + (p.citizensPercent ?? 0))) +
          (p.citizensFlat ?? 0),
      );
      recipient.economy.citizens = next;
      recalcIncome(recipient);
      if (next !== current && bus.enabled) {
        bus.emit({ type: "citizensChanged", tick: match.tick, playerId: recipient.id, delta: next - current, total: next, cause: abilityId });
      }
      break;
    }
    case "buff":
    case "debuff":
      if (p.stat && p.op && p.value !== undefined) {
        // Timed buffs honor the caster's "buffDuration:<stat>" modifiers
        // (Epic 10, e.g. Lightning Charges lasting longer at Barrage Lv 3).
        const baseTicks = p.modifierTicks ?? null;
        addModifier(recipient, {
          id: `${caster.id}:${p.stat}:${match.tick}:${match.nextSeq()}`,
          stat: p.stat,
          op: p.op,
          value: p.value,
          sourceId: caster.id,
          remainingTicks:
            baseTicks === null
              ? null
              : Math.max(1, Math.round(computeStat(caster, `buffDuration:${p.stat}`, baseTicks))),
        });
      }
      break;
    case "resourceTransfer": {
      const transfer = p.resourceTransfer;
      if (!transfer) break;

      if (transfer.type === "currency") {
        let amount = transfer.amount ?? 0;
        if (transfer.percent !== undefined) {
          amount += Math.floor(recipient.economy.currency * transfer.percent);
        }
        amount = Math.max(0, amount);

        const actualSteal = Math.min(recipient.economy.currency, amount);
        if (actualSteal > 0) {
          recipient.economy.currency -= actualSteal;
          caster.economy.currency += actualSteal;
          if (bus.enabled) {
            bus.emit({ type: "resourceTransfer", tick: match.tick, fromId: recipient.id, toId: caster.id, resource: "currency", amount: actualSteal, cause: abilityId });
          }
        }
      } else if (transfer.type === "citizens") {
        let amount = transfer.amount ?? 0;
        if (transfer.percent !== undefined) {
          amount += Math.floor(recipient.economy.citizens * transfer.percent);
        }
        amount = Math.max(0, amount);

        const actualSteal = Math.min(recipient.economy.citizens, amount);
        if (actualSteal > 0) {
          recipient.economy.citizens -= actualSteal;
          caster.economy.citizens += actualSteal;
          recalcIncome(caster);
          recalcIncome(recipient);
          if (bus.enabled) {
            bus.emit({ type: "resourceTransfer", tick: match.tick, fromId: recipient.id, toId: caster.id, resource: "citizens", amount: actualSteal, cause: abilityId });
          }
        }
      }
      break;
    }
    case "cooldownModify": {
      const mod = p.cooldownModify;
      if (!mod) break;

      const abilityIds = Object.keys(recipient.cooldowns).filter((id) => {
        if (mod.target === "all") return true;
        if (mod.target === id) return true;

        const def = ALL_ABILITIES[id];
        if (!def) return false;

        if (mod.target === "attacks" && def.kind === "attack") return true;
        if (mod.target === "utilities" && def.kind === "utility") return true;
        if (mod.target === "ultimates" && def.kind === "ultimate") return true;

        return false;
      });

      for (const id of abilityIds) {
        const current = recipient.cooldowns[id];
        if (current !== undefined) {
          let next = current;
          if (mod.op === "set") {
            next = mod.value;
          } else if (mod.op === "add") {
            next += mod.value;
          } else if (mod.op === "multiply") {
            next = Math.round(next * mod.value);
          }

          if (next <= 0) {
            delete recipient.cooldowns[id];
          } else {
            recipient.cooldowns[id] = next;
          }
        }
      }
      break;
    }
    case "vision": {
      const vis = p.vision;
      if (!vis) break;
      const statusDef = {
        id: `vision:${vis.type}`,
        category: "debuff" as const,
        stacking: "refresh" as const,
      };
      applyStatus(recipient, statusDef, {
        sourceId: caster.id,
        durationTicks: vis.durationTicks,
      });
      break;
    }
  }
}

/** Restores castle HP, clamped to max. Returns the HP actually restored. */
function healCastle(player: PlayerState, amount: number): number {
  if (amount <= 0) return 0;
  const before = player.castle.hp;
  player.castle.hp = Math.min(player.castle.maxHp, before + amount);
  return player.castle.hp - before;
}
