import { CASTLE, CITIZENS, DARK, KITSUNE, TICK } from "../data/balance.js";
import type { Match } from "./Match.js";
import { param } from "../engine/parameters.js";

/**
 * Immutable ruleset snapshot captured when a match starts, so live balance edits
 * never affect an in-progress game (see DATA_MODELS.md → MatchConfig).
 */
export interface MatchConfig {
  roomCode: string;
  maxPlayers: number;
  tickRate: number;
  startingCitizens: number;
  startingCastleHp: number;
  /**
   * Damage Dark must absorb to fill the Unlimited Rage meter. Sent so the
   * client's meter reads the real cap instead of keeping its own copy — a
   * duplicated constant here is exactly how the HUD ended up advertising a
   * number the engine had stopped using.
   */
  rageFull: number;
  /** What a full Ancient Memory meter is worth (Kitsune's "Swift Tails"). */
  memoryFull: number;
}

/**
 * Castle HP multiplier for a crowded board.
 *
 * At six and seven seats a castle is under fire from five or six directions at
 * once, so the same starting HP that makes a duel a fight makes a full lobby a
 * race to focus one player down. Scaling health with the crowd keeps a big game
 * lasting long enough to actually play.
 *
 * Applied to the CONFIG, not to the balance constants, so it lands in the
 * immutable snapshot a match carries and cannot leak into duels, the balance
 * search, or the AI training environment.
 */
export const CROWDED_MIN_PLAYERS = 6;
export const CROWDED_HP_MULTIPLIER = 1;

/** The multiplier this seat count plays under. 1 for anything below a crowd. */
export function castleHpMultiplier(activePlayers: number): number {
  return activePlayers >= CROWDED_MIN_PLAYERS ? CROWDED_HP_MULTIPLIER : 1;
}

/** Builds the config snapshot for a match from the current balance values. */
export function createMatchConfig(match: Match): MatchConfig {
  // Counted from the seats that will actually hold a castle — spectators do not
  // shoot at anyone, so they must not inflate everyone's health.
  const multiplier = castleHpMultiplier(match.activePlayerCount);
  return {
    roomCode: match.roomCode,
    maxPlayers: match.maxPlayers,
    tickRate: TICK.RATE,
    startingCitizens: param("citizens.startingCount", CITIZENS.STARTING_COUNT),
    startingCastleHp: Math.round(
      param("castle.startingHp", CASTLE.STARTING_HP) * multiplier,
    ),
    rageFull: DARK.RAGE_FULL,
    memoryFull: KITSUNE.MEMORY_FULL,
  };
}
