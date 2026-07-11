import { generateRoomCode } from "../net/roomCode.js";
import { Match, type MatchOptions } from "./Match.js";

/**
 * Owns the set of active matches, keyed by room code. Responsible for creating
 * matches with unique room codes and looking them up / disposing of them.
 *
 * A single instance is shared per server process (created in the entry point).
 */
export class MatchManager {
  private readonly matches = new Map<string, Match>();

  /** Creates a new match with a room code unique among active matches. */
  createMatch(options?: MatchOptions): Match {
    const roomCode = generateRoomCode((code) => this.matches.has(code));
    const match = new Match(roomCode, options);
    this.matches.set(roomCode, match);
    return match;
  }

  getMatch(roomCode: string): Match | undefined {
    return this.matches.get(roomCode);
  }

  hasMatch(roomCode: string): boolean {
    return this.matches.has(roomCode);
  }

  removeMatch(roomCode: string): boolean {
    return this.matches.delete(roomCode);
  }

  getMatches(): Match[] {
    return [...this.matches.values()];
  }

  get matchCount(): number {
    return this.matches.size;
  }
}
