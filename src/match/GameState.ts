import type { MatchConfig } from "./matchConfig.js";
import type { MatchPlayer } from "./types.js";
import { createPlayerState, type PlayerState } from "./playerState.js";
import { EventBus } from "../engine/events.js";

/**
 * The central server-side game state for one active match (ticket #41): every
 * player's runtime gameplay state plus match-wide gameplay data (the current
 * tick and in-flight projectiles). Gameplay systems (economy, combat, abilities)
 * read and mutate this; it is created when the match starts.
 */
export class GameState {
  /** Current game tick (advanced by the game loop in a later ticket). */
  tick = 0;
  /** In-flight projectiles (typed once the projectile system exists). */
  readonly projectiles: unknown[] = [];
  /**
   * Gameplay event bus (ticket #204): every significant gameplay occurrence
   * publishes here. Excluded from `serialize()` — events are transient
   * signals, never synced state.
   */
  readonly events = new EventBus();

  private readonly players = new Map<string, PlayerState>();

  setPlayer(playerState: PlayerState): void {
    this.players.set(playerState.id, playerState);
  }

  getPlayer(id: string): PlayerState | undefined {
    return this.players.get(id);
  }

  getPlayers(): PlayerState[] {
    return [...this.players.values()];
  }

  get playerCount(): number {
    return this.players.size;
  }

  /** Plain, serializable view of the game state for future client sync. */
  serialize(): { tick: number; players: PlayerState[]; projectiles: unknown[] } {
    return {
      tick: this.tick,
      players: this.getPlayers(),
      projectiles: [...this.projectiles],
    };
  }
}

/**
 * Builds the initial game state for a starting match: a PlayerState for every
 * player that has selected a kingdom. (Players without a kingdom — only possible
 * for a disconnected player mid-grace — are omitted until they select one.)
 */
export function createGameState(
  matchPlayers: MatchPlayer[],
  config: MatchConfig,
): GameState {
  const state = new GameState();
  for (const p of matchPlayers) {
    if (p.kingdomId === null) continue;
    state.setPlayer(
      createPlayerState(
        { id: p.id, name: p.name, kingdomId: p.kingdomId },
        config,
      ),
    );
  }
  return state;
}
