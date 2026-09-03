import type { StatusEffectDefinition } from "../engine/status.js";
import type { MatchConfig } from "./matchConfig.js";
import type { MatchPlayer } from "./types.js";
import {
  createPlayerState,
  type PlayerState,
  type StatusTickEffect,
} from "./playerState.js";
import { EventBus } from "../engine/events.js";

/** An open Black Hole absorbing attacks until it collapses (Space ultimate). */
/** The sentinel target id that means "the volcano", not a kingdom. */
export const VOLCANO_TARGET_ID = "__volcano__";

export interface VolcanoState {
  /** The Magma kingdom that called it down — spared by the eruption. */
  ownerId: string;
  /** Damage it can still absorb before it is broken. */
  hp: number;
  /** What it started at: 1000 per living kingdom. */
  maxHp: number;
  /** Tick at which it erupts if it is still standing. */
  endTick: number;
  /**
   * Damage each kingdom has personally chipped off it, by player id.
   *
   * The eruption bill is SHARED — everyone takes the same shortfall — so this
   * does not affect anyone's damage. It is kept so the client can show who
   * actually helped, which is the information a table needs to shame a
   * free-rider into swinging next time.
   */
  contributions: Record<string, number>;
  /**
   * Statuses riding on the mountain — burns, freezes, anything an attack
   * carries.
   *
   * The volcano is not a kingdom, so it has no stats to modify and takes no
   * actions to interrupt: a freeze on it is inert, and only tick DAMAGE
   * actually does anything. It still HOLDS every status it is given, because
   * an attack that silently drops half of itself when pointed at the volcano
   * is worse than one whose second half is visibly doing nothing.
   */
  statuses: VolcanoStatus[];
}

/**
 * A status on something in the middle of the field that is not a kingdom — the
 * volcano, the monster. A deliberately thin slice of `StatusEffectInstance`:
 * modifiers, targeting bans and the rest of the player machinery have nothing
 * to act on here, so they are not carried.
 */
export interface FieldEntityStatus {
  id: string;
  /** Who applied it — tick damage keeps being credited to them. */
  sourceId: string;
  remainingTicks: number;
  stacks: number;
  tickEffects?: StatusTickEffect[];
}

/** The volcano's name for it, kept so existing imports keep reading naturally. */
export type VolcanoStatus = FieldEntityStatus;

/** The sentinel target id that means "the monster", not a kingdom. */
export const MONSTER_TARGET_ID = "__monster__";

/**
 * The monster: the one centrepiece nobody summoned.
 *
 * Sized off the living table like the volcano, but with NO clock — it leaves
 * when it is killed and not before, and it hits the whole field on its own
 * cadence for as long as it stands. See `engine/monster.ts`.
 */
/**
 * Which creature is standing there.
 *
 * ⚠️ THE SERVER OWNS THIS, and it has to: every client must be looking at the
 * same monster. Rolled once at spawn and sent with the rest of its state — a
 * client that picked its own would put a different animal on each screen in the
 * same match.
 */
export type MonsterKind = "rock" | "bat" | "dragon" | "spider" | "goblin";

export const MONSTER_KINDS: readonly MonsterKind[] = [
  "rock",
  "bat",
  "dragon",
  "spider",
  "goblin",
];

export interface MonsterState {
  /** Which of the five it is. */
  kind: MonsterKind;
  /** Damage it can still absorb. At 0 it is dead and the rewards are paid. */
  hp: number;
  /** What it started at: `MONSTER.HP_PER_PLAYER` per living kingdom. */
  maxHp: number;
  /**
   * Damage each kingdom has personally dealt it, by player id.
   *
   * Unlike the volcano's contributions this is NOT display-only: the biggest
   * number here takes one of the two rewards, so it is scored state.
   */
  damage: Record<string, number>;
  /** Who landed the most recent hit — holds the finishing blow when it dies. */
  lastHitBy: string | null;
  /** Tick of its next attack cycle. */
  nextAttackTick: number;
  /**
   * What each kingdom takes on the next SUCCESSFUL cycle. Starts at
   * `MONSTER.ATTACK_DAMAGE` and climbs every time a cycle lands, so a monster
   * left standing gets steadily more expensive to ignore.
   */
  attackDamage: number;
  /** Statuses riding on it — burns chip it and are credited to whoever set them. */
  statuses: FieldEntityStatus[];
}

/**
 * The spawn clock.
 *
 * A COUNTDOWN rather than a target tick, because it does not run continuously:
 * it is frozen while any centrepiece holds the middle of the field (including a
 * monster), so "30 seconds" means thirty seconds of a clear field.
 */
export interface MonsterSpawnState {
  /** Ticks of unblocked play left before the next roll. */
  ticksUntilRoll: number;
  /**
   * The next roll is thrown away rather than rolled.
   *
   * Set when a monster dies, so the earliest a second one can appear is two
   * intervals later. Without it a monster could be killed and replaced a tick
   * afterwards, and the table would never get the breather it just earned.
   */
  skipNextRoll: boolean;
}

/**
 * Insects' "Caprice": a butterfly holding the middle of the field.
 *
 * While it is up nobody chooses their own target — every second it re-rolls
 * them — and nobody may aim at Insects at all. Insects itself is untouched and
 * picks freely, which is the entire point: for twenty-five seconds it is the
 * only kingdom playing the game on purpose.
 */
export interface CapriceState {
  /** The Insects kingdom that called it. Exempt from the scramble, and the one
   *  kingdom nobody may target while it holds. */
  ownerId: string;
  /** Tick at which the butterfly leaves. */
  endTick: number;
  /** Ticks between re-rolls. */
  scrambleTicks: number;
}

export interface BlackHoleState {
  /** The Space player who opened it. */
  ownerId: string;
  /** Tick at which it collapses and dumps its pool. */
  endTick: number;
  /** Total damage swallowed so far. */
  accumulated: number;
  /** The last kingdom whose attack was absorbed. The fallback victim, used only
   *  when every surviving kingdom fed the hole. Null until something has been
   *  absorbed. */
  lastAttackerId: string | null;
  /**
   * Every kingdom that fed the hole. The dump goes to someone who did NOT —
   * sitting the fight out is what the collapse punishes — so this is the set it
   * is chosen against. An array rather than a Set so the state stays plainly
   * serializable.
   */
  fedBy: string[];
}

/**
 * A telegraphed field-wide strike that lands some ticks after it was cast
 * (Light's "Light Show"). Everyone can see it coming — that warning window is
 * the point: it is time to go buy a shield.
 */
export interface PendingStrike {
  /** The player who called it down; never hit by their own strike. */
  ownerId: string;
  /** The ability that scheduled it (for events and VFX). */
  abilityId: string;
  /** Tick at which it lands. */
  resolveTick: number;
  /** Damage dealt to each kingdom that is UNSHIELDED when it lands. */
  amount: number;
  element?: string;
  /**
   * Shields are annihilated outright when it lands, whatever their remaining
   * health, and absorb the strike completely — a shielded kingdom loses the
   * shield and takes NO damage, with nothing carrying over to castle HP.
   */
  breaksShields: boolean;
  /**
   * A status applied to each kingdom the strike lands on. It rides ALONG with
   * the damage rather than being applied at cast, so a delayed hit (Joker's
   * Blackjack) doesn't tip its own reveal — the victim learns the suit when the
   * card arrives, not before it.
   */
  rider?: { status: StatusEffectDefinition; durationTicks: number };
  /**
   * When set, ONLY this kingdom is struck rather than the whole field — a
   * single delayed hit whose damage was already resolved at cast time and is
   * simply waiting for its projectile to arrive (Joker's Blackjack, whose card
   * must physically reach the victim before it hurts them).
   */
  targetId?: string;
}

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

  /**
   * Space's Black Hole (ultimate): while open, every offensive attack on the
   * field is swallowed instead of landing; its damage accumulates here. When it
   * collapses (`endTick`) the whole pool is dealt to the last kingdom whose
   * attack it absorbed (`lastAttackerId`). Null when no black hole is open.
   */
  blackHole: BlackHoleState | null = null;

  /**
   * Magma's "Floor is Lava": while this is live, every burn on the field hits
   * harder. Match-wide rather than per-player — see `engine/lavaFloor.ts`.
   */
  lavaFloor: { ownerId: string; endTick: number; multiplier: number } | null = null;

  /**
   * Magma's "The End of the World": a volcano standing in the middle of the
   * battlefield that every OTHER kingdom must break before the timer runs out.
   *
   * Not a player — it has no economy, no abilities and cannot be eliminated —
   * so it lives here rather than in the player map, and the one place it is
   * treated like a kingdom is as a target id (see `VOLCANO_TARGET_ID`).
   */
  volcano: VolcanoState | null = null;

  /**
   * Insects' "Caprice" — the butterfly scrambling everyone's aim. Null when
   * none is out.
   */
  caprice: CapriceState | null = null;

  /**
   * The monster standing in the middle of the field, or null when there is
   * none. Not owned by any kingdom — see `engine/monster.ts`.
   */
  monster: MonsterState | null = null;

  /**
   * The monster spawn clock. Null until the first tick arms it, so the interval
   * is read through the parameter gate rather than frozen at construction.
   */
  /**
   * A collapsed Black Hole's damage, waiting for its beam to arrive.
   *
   * The victim and the amount are decided AT COLLAPSE (the client aims the beam
   * off that same event); only the damage waits. Never more than one: a hole
   * runs for at least ten seconds, so a second collapse cannot overtake a dump
   * that is only 3.6 seconds behind.
   */
  pendingBlackHoleDump: {
    ownerId: string;
    victimId: string;
    amount: number;
    resolveTick: number;
  } | null = null;

  monsterSpawn: MonsterSpawnState | null = null;

  /**
   * How many monsters this match has seen, including the one on the field.
   *
   * Drives the health ramp (`MONSTER.HP_PER_PLAYER_STEP`) and never resets: it
   * counts the match, not the creature.
   */
  monsterSpawnCount = 0;

  /**
   * The kind that spawned last, so the next roll can avoid repeating it.
   *
   * ⚠️ NOT A FAIRNESS RULE, A LEGIBILITY ONE. One kind in five means a
   * back-to-back repeat lands one time in five, and at that rate a table
   * genuinely concludes the game only has one monster — which is what a real
   * uniform roll cost us. Excluding the last one is the cheapest way to make
   * "there are five of these" true on screen instead of only in the data.
   */
  lastMonsterKind: MonsterKind | null = null;

  /**
   * Telegraphed strikes waiting to land (Light's "Light Show"). Resolved once
   * per tick by `resolvePendingStrikes`, before death detection so a fatal one
   * settles the same tick.
   */
  readonly pendingStrikes: PendingStrike[] = [];

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
        { id: p.id, name: p.name, kingdomId: p.kingdomId, perks: p.perks ?? [] },
        config,
      ),
    );
  }
  return state;
}
