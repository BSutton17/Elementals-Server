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
      /**
       * Attacks Air's wind passive deflected (Epic 9 VFX). Each entry maps the
       * kingdom that intercepted the shot (`via`) to the kingdom it was turned
       * toward (`to`, also in `targetIds`). The renderer plays a two-leg
       * deflection (attacker → via → to); absent when nothing was redirected.
       */
      redirects?: { via: string; to: string }[];
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
      /**
       * A decoy damage number that did NOT actually land (Love's "Love Galore"
       * stealth phase): the hit was silently converted to healing, but enemies
       * still see a normal-looking damage number. The client hides it from the
       * bearer (they know they weren't hurt) and shows it to everyone else.
       */
      phantom?: boolean;
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
      // A two-phase hidden status revealed itself (Love's "Love Galore"): its
      // stealth window ended or its healing threshold was crossed. The client
      // starts the reveal aura and switches from phantom damage to visible
      // healing numbers on the bearer. The status stays active for a fresh
      // window afterward.
      type: "statusRevealed";
      tick: number;
      playerId: string;
      statusId: string;
    }
  | {
      // Time's Blip! rewound the most recent attack on `playerId`: HP/shield
      // restored, its statuses stripped. `sourceId`/`abilityId` name the undone
      // attack so the client can rewind a travel projectile back to its caster.
      type: "attackUndone";
      tick: number;
      playerId: string;
      sourceId: string;
      abilityId: string;
      removedStatusIds: string[];
    }
  | {
      // A recurring status's interval tick fired (Father Time's per-second
      // punish). `interrupted` = the bearer avoided it by landing a damaging
      // attack, so the countdown reset instead of dealing damage. The damage
      // itself (when not interrupted) still arrives as a `damage` event with
      // cause `status:<id>`.
      type: "statusTick";
      tick: number;
      playerId: string;
      statusId: string;
      interrupted: boolean;
    }
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
  /** Space's Supernova meter gained progress (Shooting Star / Saturn's Rings /
   *  Orion's Belt misses). `level` is the resulting Supernova level (0–3). */
  | {
      type: "supernovaCharged";
      tick: number;
      playerId: string;
      meter: number;
      level: number;
    }
  /** Space fired its Supernova at `targetId` at the given level, emptying the
   *  meter. The damage arrives as a separate `damage` event. */
  | {
      type: "supernovaFired";
      tick: number;
      playerId: string;
      targetId: string;
      level: number;
    }
  /** An incoming attack was negated by Orion's Belt (a chance-based miss on the
   *  bearer). `attackerId`/`abilityId` name the whiffed attack. */
  | {
      type: "attackMissed";
      tick: number;
      playerId: string;
      attackerId: string;
      abilityId: string;
      cause: string;
    }
  /** Space's Black Hole opened over the field (`playerId` = its owner); for
   *  `durationTicks` all attacks are absorbed into it. */
  | {
      type: "blackHoleOpened";
      tick: number;
      playerId: string;
      durationTicks: number;
    }
  /** The Black Hole swallowed an attack's damage instead of it landing. */
  | {
      type: "blackHoleAbsorbed";
      tick: number;
      ownerId: string;
      attackerId: string;
      amount: number;
    }
  /** The Black Hole collapsed, dumping all absorbed damage onto `victimId`. */
  | {
      type: "blackHoleCollapsed";
      tick: number;
      ownerId: string;
      victimId: string | null;
      amount: number;
    }
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
