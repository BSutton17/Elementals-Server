/**
 * Centralized game-balance constants for Kingdoms.
 *
 * This is the single source of truth for tunable gameplay values (see
 * ARCHITECTURE.md — data declares *what*, systems declare *how*). Nothing here
 * contains logic; systems import these values rather than hardcoding them, so
 * rebalancing is a data-only change. Values are snapshotted into a match's
 * config at start (see DATA_MODELS.md → MatchConfig) so live edits never disturb
 * an in-progress match.
 *
 * NOTE: magnitudes below are initial defaults and are expected to be tuned by
 * later balance tickets.
 */

/** Castle defaults. */
export const CASTLE = {
  /** Starting Castle HP for every player. */
  STARTING_HP: 10_000,
  /** Maximum HP restored by a single repair action. */
  REPAIR_AMOUNT: 1000,
  /** Flat base cost of a repair (before growth scaling). */
  REPAIR_COST: 500,
  /**
   * Multiplicative cost growth per repair already purchased, so repeated
   * repairs get progressively more expensive (500 → 625 → 781).
   */
  REPAIR_COST_GROWTH: 1.25,
  /**
   * Hard cap on purchased repairs per match. Ability-based healing (Riptide,
   * lifesteal, …) is NOT limited — only the shop's repair button.
   */
  MAX_REPAIRS: 3,
} as const;

/** Citizen / economy defaults. */
export const CITIZENS = {
  /** Number of citizens each player begins a match with. */
  STARTING_COUNT: 10,
} as const;

/** Economy tuning. */
export const ECONOMY = {
  /** Money awarded per citizen, per tick (0.05 per tick = 1.00 per second at 20 ticks/sec). */
  INCOME_PER_CITIZEN: 0.06,
  /** Base cost of the first purchased citizen. */
  CITIZEN_COST: 25,
  /**
   * Multiplicative cost growth per citizen already purchased, so each purchase
   * costs more (progressive scaling): cost = CITIZEN_COST × GROWTH^purchased,
   * rounded to whole dollars.
   */
  CITIZEN_COST_GROWTH: 1.10,
} as const;

/** Combat defaults shared by all abilities unless overridden by ability data. */
export const COMBAT = {
  /** Base chance (0–1) for an attack to critically strike. */
  BASE_CRIT_CHANCE: 0.05,
  /** Damage multiplier applied on a critical strike. */
  BASE_CRIT_MULTIPLIER: 1.5,
  /**
   * "Besieged" comeback bonus: when several kingdoms gang up on you, your own
   * attacks hit harder. Each enemy *beyond the first* currently targeting you
   * grants this fraction of extra outgoing attack damage — so a fair 1v1 is
   * unbuffed, but being triple-teamed pays you back for the pressure.
   */
  BESIEGED_DAMAGE_PER_ATTACKER: 0.1,
  /** Cap on besieging attackers that count toward the bonus (beyond the first). */
  BESIEGED_MAX_STACKS: 6,
  /**
   * Besieged also rallies your economy: each besieging attacker beyond the
   * first grants this many extra gold PER SECOND (your citizens work harder to
   * fund the defense). Uses the same capped stack count as the damage bonus.
   */
  BESIEGED_INCOME_PER_ATTACKER: 2,
} as const;

/** Lobby / room defaults. */
export const LOBBY = {
  /** Number of characters in a generated room code. */
  ROOM_CODE_LENGTH: 4,
} as const;

/** Match / player-count rules. */
export const MATCH = {
  /** Minimum players required to start a match. */
  MIN_PLAYERS: 2,
  /** Maximum total seats in a room (players + spectators). */
  MAX_PLAYERS: 8,
  /** Maximum kingdom-playing participants; the remaining seat(s) up to
   *  MAX_PLAYERS may only join as spectators. */
  MAX_ACTIVE_PLAYERS: 7,
} as const;

/** Game-loop timing. */
export const TICK = {
  /** Server ticks per second (see GAME_TICK.md). */
  RATE: 20,
  /** Broadcast a game-state sync every N ticks (20/2 = ~10 Hz). */
  SYNC_EVERY_TICKS: 2,
} as const;

/** Shield defaults. */
export const SHIELD = {
  /** Health of the standard purchasable shield. */
  STANDARD_HP: 1750,
  /** Cost of the first shield (matches the client's shop display). */
  COST: 500,
  /**
   * Multiplier applied per shield already bought this match, so each shield
   * costs a little more than the last (500 → 525 → 551 → …). Only one shield
   * can be active at a time, so this scales with cumulative purchases.
   */
  COST_GROWTH: 1.05,
  /**
   * After a shield is broken by damage, this many ticks must pass before a new
   * one can be bought (7.5 s) — you can't instantly re-wall mid-assault.
   */
  BREAK_COOLDOWN_TICKS: 7.5 * 20,
} as const;

/** Space kingdom — the Supernova charge meter (Shooting Star / Saturn's Rings /
 *  Orion's Belt misses fill it; Supernova fires at the current level). */
export const SPACE = {
  /**
   * Cumulative meter "xp" required to reach Supernova levels 1, 2, and 3. The
   * cost per level ramps: 50 to reach L1, +100 for L2 (150 total), +200 for L3
   * (250 total). The last entry doubles as the full-charge cap.
   */
  SUPERNOVA_LEVEL_THRESHOLDS: [50, 150, 250],
} as const;

/** Targeting rules. */
export const TARGETING = {
  /** Anti-spam cooldown between switching targets, in seconds. */
  SWITCH_COOLDOWN_SECONDS: 3.5,
  /** The same cooldown in ticks, derived from the tick rate (3.5 s × 20 = 70). */
  SWITCH_COOLDOWN_TICKS: 3.5 * TICK.RATE,
} as const;

/** Reconnection handling. */
export const RECONNECT = {
  /**
   * Grace period (ms) a disconnected player is kept in their seat before being
   * removed. During this window their slot, position, and kingdom stay reserved
   * so nobody else can take them. Default 60 seconds; overridable via the
   * RECONNECT_GRACE_MS environment variable.
   */
  GRACE_MS: 60_000,
} as const;
