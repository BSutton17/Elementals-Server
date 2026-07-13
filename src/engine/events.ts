/**
 * Gameplay event framework (ticket #204).
 *
 * Every significant gameplay occurrence is published as a typed event on the
 * match's EventBus. Consumers — the simulation recorder, the live `evt:*`
 * network layer, replays, future animations — subscribe and translate; they
 * never duplicate gameplay logic to infer what happened.
 *
 * Hard rules:
 *  - Emission NEVER affects gameplay: producers fire-and-forget, listener
 *    exceptions are swallowed, and with zero listeners `emit` is a no-op
 *    (producers guard object construction behind `bus.enabled`, keeping the
 *    hot path allocation-free for live matches with no subscribers).
 *  - Events describe WHAT happened in gameplay units. Rendering concerns
 *    (pixels, animation names) never appear here.
 */

/** Why a value changed — an ability id, `status:<id>`, or a system tag. */
export type EventCause = string;

export type GameplayEvent =
  | {
      type: "abilityCast";
      tick: number;
      casterId: string;
      abilityId: string;
      targetIds: string[];
      cost: number;
      chargesUsed?: number;
    }
  | {
      type: "damage";
      tick: number;
      sourceId: string;
      targetId: string;
      amount: number;
      absorbedByShield: number;
      dealtToHp: number;
      /** Damage that could not land because the target was already at 0 HP
       *  (or the hit exceeded remaining HP) — the "wasted" portion. */
      overkill: number;
      crit: boolean;
      element?: string;
      cause: EventCause;
    }
  | {
      type: "heal";
      tick: number;
      targetId: string;
      /** HP actually restored (effective healing). */
      amount: number;
      /** Requested healing that was wasted because the castle was near full. */
      overheal: number;
      cause: EventCause;
    }
  | {
      type: "shieldGained";
      tick: number;
      playerId: string;
      amount: number;
      total: number;
      cause: EventCause;
    }
  | { type: "shieldDestroyed"; tick: number; playerId: string; cause: EventCause }
  | {
      type: "statusApplied";
      tick: number;
      targetId: string;
      sourceId: string;
      statusId: string;
      durationTicks: number;
      stacks: number;
    }
  | { type: "statusExpired"; tick: number; playerId: string; statusId: string }
  | {
      type: "purchase";
      tick: number;
      playerId: string;
      kind: "citizen" | "repair" | "shield" | "unlock" | "upgrade";
      /** The ability id for unlock/upgrade purchases. */
      itemId?: string;
      cost: number;
    }
  | {
      type: "citizensChanged";
      tick: number;
      playerId: string;
      delta: number;
      total: number;
      cause: EventCause;
    }
  | {
      type: "resourceTransfer";
      tick: number;
      fromId: string;
      toId: string;
      resource: "currency" | "citizens";
      amount: number;
      cause: EventCause;
    }
  | {
      type: "castFailed";
      tick: number;
      casterId: string;
      abilityId: string;
      /** The engine rejection reason (ON_COOLDOWN, INSUFFICIENT_FUNDS, …). */
      reason: string;
      /** When the rejection was caused by an active status on the caster (e.g.
       *  a crowd-control status barring attacks), the id of that status —
       *  populated generically from the caster's active statuses, never by
       *  naming a specific one. Absent for non-status rejections. */
      statusId?: string;
    }
  | { type: "eliminated"; tick: number; playerId: string }
  | { type: "targetChanged"; tick: number; playerId: string; targetId: string }
  | { type: "cooldownReady"; tick: number; playerId: string; abilityId: string }
  | {
      type: "chargeReady";
      tick: number;
      playerId: string;
      abilityId: string;
      /** How many charges finished regenerating on this tick. */
      regenerated: number;
    }
  | { type: "matchEnded"; tick: number; winnerId: string | null }
  /** Reserved for the projectile system (GAME_TICK.md §5); no emitter yet. */
  | {
      type: "projectileSpawned";
      tick: number;
      projectileId: string;
      sourceId: string;
      targetId: string;
      kind: string;
      impactTick: number;
    };

export type GameplayEventListener = (event: GameplayEvent) => void;

/**
 * A minimal synchronous pub/sub bus, one per match. Deliberately tiny: no
 * wildcards, no async, no ordering guarantees beyond emission order — the
 * cheapest thing that can feed recorders and the network layer.
 */
export class EventBus {
  private listeners: GameplayEventListener[] = [];

  /** True when anyone is listening — producers guard emission on this so a
   *  live match with no subscribers pays nothing. */
  get enabled(): boolean {
    return this.listeners.length > 0;
  }

  /** Subscribes; returns an unsubscribe function. */
  on(listener: GameplayEventListener): () => void {
    this.listeners.push(listener);
    return () => this.off(listener);
  }

  off(listener: GameplayEventListener): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /** Publishes to all listeners. Listener errors are swallowed — events must
   *  never affect gameplay (#204). */
  emit(event: GameplayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers are read-only conveniences; a broken one cannot be
        // allowed to break the authoritative simulation.
      }
    }
  }
}
