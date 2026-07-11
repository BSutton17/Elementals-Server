import { KINGDOM_PASSIVES, type KingdomId } from "../data/kingdoms.js";
import type { MatchConfig } from "./matchConfig.js";
import type { EffectCondition } from "../engine/conditions.js";
import type { StatusEffectDefinition } from "../engine/status.js";

// The runtime per-player gameplay object (tickets #42, #43; see DATA_MODELS.md →
// Player). Created when a match starts. Collections whose element shapes are
// owned by later tickets (status effects, combos) are typed loosely for now and
// filled in as those systems land.

export interface CastleState {
  /** Castle health. */
  hp: number;
  maxHp: number;
  /** Shield health absorbed before HP; starts at 0. */
  shield: number;
  /** Number of repairs purchased (drives progressive repair cost). */
  repairs: number;
}

export interface EconomyState {
  /** Population; drives income. */
  citizens: number;
  /** Spendable money. */
  currency: number;
  /** Derived from citizens by the economy system; 0 until it runs. */
  incomePerTick: number;
  /** How many citizens the player has purchased (drives progressive cost). */
  citizensPurchased: number;
}

export type ModifierOp = "add" | "mult";

/**
 * A temporary bonus/penalty to a named player statistic (ticket #48). Effective
 * stat = (base + sum of `add`) × product of `mult`.
 */
export interface Modifier {
  /** Unique instance id (for removal). */
  id: string;
  /** The statistic this affects (e.g. "income", "damage"). */
  stat: string;
  op: ModifierOp;
  value: number;
  sourceId: string;
  /** Remaining ticks; null = lasts until explicitly removed. */
  remainingTicks: number | null;
  /** Conditional modifiers (ticket #101). */
  conditions?: EffectCondition[];
  /** Usage limit (ticket #103). */
  usageLimit?: number;
  /** String value for targeting redirection, etc. (ticket #109) */
  stringValue?: string;
}

/**
 * A recurring per-tick effect carried by a status (ticket #78) — e.g. burn
 * damage or a regeneration heal, optionally scaling with stack count.
 */
export interface StatusTickEffect {
  type: "damage" | "heal";
  /** Magnitude per tick (per stack when `perStack` is set). */
  amount: number;
  /** Multiply by the status's current stacks (poison-style ramping). */
  perStack?: boolean;
  /** damage: bypass the target's shield pool. */
  ignoreShields?: boolean;
  /** Probability check (ticket #102). */
  chance?: number;
}

/**
 * An active status effect on a player. Duration, stacking, source tracking,
 * and its snapshot of recurring tick effects (#76, #78).
 */
export interface StatusEffectInstance {
  /** Status definition id (e.g. "burn", "freeze"). */
  id: string;
  /** Player who applied it. */
  sourceId: string;
  /** Remaining ticks before it expires. */
  remainingTicks: number;
  /** Current stack count. */
  stacks: number;
  /** Recurring per-tick effects, snapshotted from the definition on apply. */
  tickEffects?: StatusTickEffect[];
  /** Whether the status has associated modifiers. */
  hasModifiers?: boolean;
  /**
   * While active, the bearer cannot *target* the player who applied this
   * status (`sourceId`) — other targets remain legal (tickets #87–#88,
   * e.g. Water's Flood). Snapshotted from the definition on apply.
   */
  blocksTargetingSource?: boolean;
  /**
   * While active, the bearer's next attack on the player who applied this
   * status (`sourceId`) is deflected to another valid kingdom (Air's
   * Hurricane, Epic 8). Consumed on use. Snapshotted on apply.
   */
  deflectsAttackOnSource?: { damageMult?: number; chainChance?: number };
  /** Whether a `chainChance` roll has already granted the one extra deflection. */
  deflectionChained?: boolean;
  /** While active, the bearer cannot activate attack-kind abilities
   *  (Ice's Frozen/Blizzard, Epic 11). Snapshotted on apply. */
  blocksAttacks?: boolean;
  /** Chance-gated effects of the bearer's attacks always proc; one stack is
   *  consumed per attack (Ice's Frozen Focus, Epic 11). */
  guaranteesChanceEffects?: boolean;
  /** Applied to the bearer when this expires naturally (Epic 11). */
  onExpireStatus?: { status: StatusEffectDefinition; durationTicks: number };
  /** While active, the bearer cannot buy citizens or repair (Epic 12,
   *  Nature's Toxic Gas). */
  blocksPurchases?: boolean;
  /** Applied to the next player who damages the bearer, then consumed
   *  (Epic 12, Nature's Poison Apple). */
  onHitRetaliate?: { status: StatusEffectDefinition; durationTicks: number };
}

export interface PlayerState {
  id: string;
  name: string;
  kingdomId: KingdomId;
  castle: CastleState;
  economy: EconomyState;
  /** Active status effects. */
  statuses: StatusEffectInstance[];
  /** Active stat modifiers (buffs/debuffs). */
  modifiers: Modifier[];
  /** Active combo states (ComboState[] later). */
  combos: unknown[];
  /** Ability cooldowns remaining (ticks), keyed by ability id. */
  cooldowns: Record<string, number>;
  /**
   * Charge regeneration timers per charge-based ability (Lightning Barrage):
   * one countdown (ticks) per spent charge, each regenerating independently.
   * Available charges = the ability's max − this list's length.
   */
  recharges: Record<string, number[]>;
  /** Purchased upgrade level per ability id. */
  upgrades: Record<string, number>;
  /**
   * Abilities the player has bought (unlock cost = 50% of cast cost). A bought
   * ability is "level 1" in UI terms; `upgrades` then counts tiers past that.
   */
  unlocked: Record<string, boolean>;
  /** Currently selected target (player id), or null. */
  target: string | null;
  /**
   * The earliest tick at which this player may switch to a *different* target
   * (anti-spam cooldown, ticket #61). 0 = may switch immediately. Clients derive
   * remaining time from `(this − currentTick)` per the SOCKET_EVENTS time rule.
   */
  targetSwitchReadyTick: number;
  eliminated: boolean;
  /**
   * Tick at which this kingdom was eliminated and cleaned up, or null while
   * alive (tickets #69–#70). Preserved for end-of-match statistics; also marks
   * whether the elimination process has run (death detection processes each
   * dead castle exactly once).
   */
  eliminatedAtTick: number | null;
}

/**
 * Builds a player's initial gameplay state from their selected kingdom and the
 * shared game constants captured in the match config (ticket #43). Kingdom-
 * specific starting-stat overrides can be layered here once kingdom definitions
 * exist; for now every kingdom uses the shared starting values.
 */
export function createPlayerState(
  input: { id: string; name: string; kingdomId: KingdomId },
  config: MatchConfig,
): PlayerState {
  let startingHp = config.startingCastleHp;
  let startingShield = 0;
  let startingCitizens = config.startingCitizens;
  const passives = KINGDOM_PASSIVES[input.kingdomId] ?? [];
  for (const p of passives) {
    if (p.type === "startingCastleHpMultiplier") {
      startingHp = Math.round(startingHp * p.pct);
    }
    // Earth's "Rock Hard Determination" (Epic 9): start fully shielded.
    if (p.type === "startingShield") {
      startingShield += p.amount;
    }
    // Nature's "Gardener's Gift" (Epic 12): start with extra citizens.
    if (p.type === "startingCitizensBonus") {
      startingCitizens += p.amount;
    }
  }

  return {
    id: input.id,
    name: input.name,
    kingdomId: input.kingdomId,
    castle: {
      hp: startingHp,
      maxHp: startingHp,
      shield: startingShield,
      repairs: 0,
    },
    economy: {
      citizens: startingCitizens,
      currency: 0,
      incomePerTick: 0,
      citizensPurchased: 0,
    },
    statuses: [],
    modifiers: [],
    combos: [],
    cooldowns: {},
    recharges: {},
    upgrades: {},
    unlocked: {},
    target: null,
    targetSwitchReadyTick: 0,
    eliminated: false,
    eliminatedAtTick: null,
  };
}
