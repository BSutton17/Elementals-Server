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
  CITIZEN_COST: 10,
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
  /** Maximum players allowed in a match. */
  MAX_PLAYERS: 8,
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
  STANDARD_HP: 1000,
  /** Cost of the standard shield (matches the client's shop display). */
  COST: 500,
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
