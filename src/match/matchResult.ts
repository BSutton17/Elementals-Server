import type { Match } from "./Match.js";
import type { MatchStats, PlayerState } from "./playerState.js";
import type { KingdomId } from "../data/kingdoms.js";
import { createId } from "../util/id.js";

/**
 * The record of a finished match.
 *
 * Until this existed, the end of a fifteen-minute game produced exactly one
 * fact: `{ winnerId }`. Everything downstream — the scoreboard, profiles, XP,
 * coins, and the per-kingdom win rates that turn balance from an argument into
 * a measurement — reads from here.
 *
 * Built once, at the end, from state the engine has been keeping all along.
 */

export interface MatchParticipantResult {
  playerId: string;
  name: string;
  kingdomId: KingdomId | null;
  /** The account this seat belongs to, or null for a guest or a bot. */
  accountId: string | null;
  isBot: boolean;
  /** Bot skill, for reward weighting. Null for humans. */
  botDifficulty: string | null;
  /** 1 = winner. See `placementsFor` for how ties are handled. */
  placement: number;
  /** Tick this kingdom fell, or null if it survived to the end. */
  eliminatedAtTick: number | null;
  /** How long this seat was actually in the fight. */
  survivedTicks: number;
  /** Castle HP left when the match ended. 0 for anyone eliminated. */
  hpRemaining: number;
  /** The castle's maximum, so "how close to full" is answerable without
   *  knowing the player-count scaling that set it. */
  maxHp: number;
  stats: MatchStats;
}

export interface MatchResult {
  /**
   * Generated once, when the result is built. Recording the same result twice
   * is therefore a no-op rather than a duplicated match — see db/matches.ts.
   */
  matchId: string;
  roomCode: string;
  /** Server-side wall clock, for ordering match history. */
  endedAt: string;
  durationTicks: number;
  tickRate: number;
  /** Every seat, winner first. */
  participants: MatchParticipantResult[];
  /** Total seats, humans and bots. */
  playerCount: number;
  /**
   * Whether this was a matchmade public room.
   *
   * Private rooms pay a reduced rate: they are the game's heart, but they are
   * also the only place a lobby can be curated, and matchmaking is where you
   * do not choose your opponents.
   */
  isPublic: boolean;
  /** ⚠️ Humans only. Reward rules key off this, not `playerCount`, or a lobby
   *  padded with bots would pay like a full house. */
  humanCount: number;
  winnerId: string | null;
  /**
   * Stamped so a later analysis can exclude matches played under balance
   * numbers that have since changed. Without it, a rebalance quietly poisons
   * every historical win rate.
   */
  balanceVersion: string;
}

/**
 * Places every player: last kingdom standing is 1st, and everyone else is
 * ranked by how long they lasted.
 *
 * ⚠️ SURVIVORS TIE, THEY DO NOT GET ORDERED. A match can end with several
 * kingdoms alive (a draw, or a host closing the room), and inventing an order
 * between them from something incidental — seat index, HP remaining — would be
 * a result the game never actually produced. They share the top placement, and
 * the next placement skips accordingly, exactly like a race.
 */
export function placementsFor(players: readonly PlayerState[]): Map<string, number> {
  const survivors = players.filter((p) => p.eliminatedAtTick === null);
  const fallen = players
    .filter((p) => p.eliminatedAtTick !== null)
    // Latest death first: outlasting everyone else places you higher.
    .sort((a, b) => (b.eliminatedAtTick ?? 0) - (a.eliminatedAtTick ?? 0));

  const placements = new Map<string, number>();
  for (const survivor of survivors) placements.set(survivor.id, 1);

  // Standard competition ranking: three survivors are all 1st, and the first
  // kingdom to fall is 4th.
  let next = survivors.length + 1;
  let previousTick: number | null = null;
  let sharedPlacement = next;

  for (const player of fallen) {
    // Kingdoms eliminated on the same tick genuinely tied.
    if (player.eliminatedAtTick === previousTick) {
      placements.set(player.id, sharedPlacement);
    } else {
      sharedPlacement = next;
      placements.set(player.id, sharedPlacement);
      previousTick = player.eliminatedAtTick;
    }
    next += 1;
  }

  return placements;
}

/** Builds the result for a finished match. */
export function buildMatchResult(match: Match, balanceVersion = "0"): MatchResult | null {
  const state = match.gameState;
  if (!state) return null;

  const players = state.getPlayers();
  const placements = placementsFor(players);
  const endTick = match.tick;

  const participants: MatchParticipantResult[] = players.map((player) => {
    const seat = match.getPlayer(player.id);
    return {
      playerId: player.id,
      name: player.name,
      kingdomId: player.kingdomId,
      accountId: seat?.accountId ?? null,
      isBot: seat?.isBot === true,
      botDifficulty: seat?.botDifficulty ?? null,
      placement: placements.get(player.id) ?? players.length,
      eliminatedAtTick: player.eliminatedAtTick,
      survivedTicks: player.eliminatedAtTick ?? endTick,
      hpRemaining: Math.max(0, Math.round(player.castle.hp)),
      maxHp: Math.max(1, Math.round(player.castle.maxHp)),
      stats: player.stats,
    };
  });

  participants.sort((a, b) => a.placement - b.placement);

  return {
    matchId: createId(),
    roomCode: match.roomCode,
    endedAt: new Date().toISOString(),
    durationTicks: endTick,
    tickRate: match.config?.tickRate ?? 20,
    participants,
    playerCount: participants.length,
    isPublic: match.visibility === "public",
    humanCount: participants.filter((p) => !p.isBot).length,
    winnerId: match.winnerId ?? null,
    balanceVersion,
  };
}
