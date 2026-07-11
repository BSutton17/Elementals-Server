import { CASTLE, CITIZENS, TICK } from "../data/balance.js";
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
}

/** Builds the config snapshot for a match from the current balance values. */
export function createMatchConfig(match: Match): MatchConfig {
  return {
    roomCode: match.roomCode,
    maxPlayers: match.maxPlayers,
    tickRate: TICK.RATE,
    startingCitizens: param("citizens.startingCount", CITIZENS.STARTING_COUNT),
    startingCastleHp: param("castle.startingHp", CASTLE.STARTING_HP),
  };
}
