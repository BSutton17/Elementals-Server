import type { Server } from "socket.io";
import type { Match } from "../match/Match.js";
import { buildMatchResult } from "../match/matchResult.js";
import { recordMatchResult } from "../db/matches.js";
import type { PlayerState } from "../match/playerState.js";
import type { GameplayEvent } from "../engine/events.js";
import {
  abilityUnlockCost,
  citizenCost,
  dispellableStatus,
  repairCost,
  shieldCost,
} from "../engine/purchases.js";
import { abilityUpgradeCost, resolveAbility } from "../engine/abilities.js";
import { abilitiesForKingdom } from "../data/kingdomAbilities.js";
import { standingCentrepiece } from "../engine/centrepiece.js";
import { SHIELD } from "../data/balance.js";
import { param } from "../engine/parameters.js";
import { partyForWire } from "./partySync.js";
import {
  kitKingdomOf,
  mirrorSlot,
  swapGrantsUnlock,
} from "../engine/party/kingdomSwap.js";

/**
 * Broadcasts the current authoritative game state to everyone in a match's room
 * (tickets #49, #60, #63). Sent on a fixed interval by the game loop and
 * immediately after any state-changing action (a purchase, a target change).
 * Each player carries their full economy (money, income, citizens, shield) plus
 * derived purchase costs (next citizen/repair cost) and their current `target`
 * (ticket #63) via the spread of the player state, so clients have everything to
 * render the economy and targeting. This sends the full current state each time;
 * field-level deltas are a later optimization.
 */

/**
 * Every price the HUD shows for one ability, resolved for the player who owns
 * it. This is the ONLY place prices come from: `<kingdom>Abilities.ts` declares
 * them, and the client renders whatever arrives here — it holds no cost data of
 * its own, so a tag can never drift from what a click will actually charge.
 */
export interface AbilityPrices {
  /** Effective cast cost at the player's current upgrade tier. */
  cast: number;
  /**
   * Whether this ability is bought, and what tier it is at.
   *
   * ⚠️ SENT RATHER THAN WORKED OUT ON THE CLIENT, BECAUSE THE CLIENT CANNOT.
   * Both answers go through `mirrorSlot` during a Kingdom Swap — a borrowed
   * ability is levelled by the matching slot of the player's OWN kingdom, and
   * unlocked by the loan itself. The raw `unlocked`/`upgrades` maps on the wire
   * are keyed by the player's own ability ids, so a client reading them
   * directly gets `false` and `0` for every borrowed ability and draws five
   * locked buttons.
   */
  unlocked: boolean;
  /** 0 while locked; 1 once bought; +1 per upgrade tier after that. */
  level: number;
  /** Price to buy this ability, or null once it is unlocked. */
  unlock: number | null;
  /** Price of the next upgrade tier, or null while locked or fully upgraded. */
  upgrade: number | null;
  /** Charge-based abilities (Lightning Barrage): the charge economy at this
   *  tier — per-charge price, damage by charges spent, and regen cadence. */
  charges?: {
    max: number;
    costPerCharge: number;
    damageByCharges: number[];
    rechargeTicks: number;
  };
}

/**
 * The full price table for every ability of a player's kingdom, with upgrade
 * tiers (`cost` overrides, `costMultiplier` discounts), balance-parameter
 * overrides, and the player's perks all applied.
 *
 * Exported for tests; production callers go through `broadcastGameState`.
 */
export function abilityPrices(p: PlayerState): Record<string, AbilityPrices> {
  const prices: Record<string, AbilityPrices> = {};
  // The kit they are HOLDING — another kingdom's during a Kingdom Swap — priced
  // against the slots they own in their own.
  for (const def of abilitiesForKingdom(kitKingdomOf(p))) {
    const level = p.upgrades[mirrorSlot(p, def.id)] ?? 0;
    const resolved = resolveAbility(def, level);
    // A borrowed kit arrives unlocked — see `swapGrantsUnlock`. Otherwise a
    // swap hands the player five buttons they cannot press.
    const unlocked =
      swapGrantsUnlock(p, def.id) || p.unlocked[mirrorSlot(p, def.id)] === true;
    const nextTier = (def.upgradePath ?? []).find((t) => t.level === level + 1);

    prices[def.id] = {
      cast: resolved.cost ?? 0,
      // Mirrors `unlockOrUpgradeAbility`: the explicit unlock price when set,
      // otherwise half the cast cost, then the player's perk discount.
      unlocked,
      // The bar counts a bought ability as level 1 and stacks tiers on top.
      level: unlocked ? level + 1 : 0,
      unlock: unlocked ? null : abilityUnlockCost(p, def),
      upgrade:
        unlocked && nextTier ? abilityUpgradeCost(p, def, nextTier) : null,
      ...(resolved.chargeSystem
        ? {
            charges: {
              max: resolved.chargeSystem.max,
              costPerCharge: resolved.chargeSystem.costPerCharge,
              damageByCharges: [...resolved.chargeSystem.damageByCharges],
              rechargeTicks: resolved.chargeSystem.rechargeTicks,
            },
          }
        : {}),
    };
  }
  return prices;
}

export function broadcastGameState(io: Server, match: Match): void {
  const state = match.gameState;
  if (!state) return;

  io.to(match.roomCode).emit("state:sync", {
    tick: state.tick,
    serverTime: Date.now(),
    players: state.getPlayers().map((p) => ({
      ...p,
      // Server-side bookkeeping, and of no use to a client: who has ever hit
      // whom only gates the besieged bonuses. A Set serializes to `{}` in any
      // case, so leaving it in would put an empty object on the wire for every
      // player twenty times a second.
      attackedBy: undefined,
      economy: { ...p.economy, nextCitizenCost: citizenCost(p) },
      castle: {
        ...p.castle,
        nextRepairCost: repairCost(p),
        nextShieldCost: shieldCost(p),
        // Ticks left on the buy-shield break cooldown (0 = ready to rebuy).
        shieldCooldownRemaining: Math.max(
          0,
          param("shield.breakCooldownTicks", SHIELD.BREAK_COOLDOWN_TICKS) -
            (state.tick - p.castle.shieldBrokenAtTick),
        ),
      },
      abilityPrices: abilityPrices(p),
      // What it currently costs this player to buy their way out of a status
      // (Light's Fireflies), or null when they hold nothing dispellable.
      dispel: dispellableStatus(p),
    })),
    projectiles: [],
    // Insects' "Caprice". Synced to everyone: the butterfly is the whole
    // table's problem, and the client needs to know when to stop offering a
    // targeting UI that the server is about to overrule anyway.
    caprice: state.caprice
      ? {
          ownerId: state.caprice.ownerId,
          ticksRemaining: Math.max(0, state.caprice.endTick - state.tick),
        }
      : null,
    // Magma's "The End of the World". Synced to EVERYONE, not just Magma: the
    // whole table has to be able to see it, click it and watch its health fall,
    // because breaking it in time is a job none of them can do alone.
    volcano: state.volcano
      ? {
          ownerId: state.volcano.ownerId,
          hp: state.volcano.hp,
          maxHp: state.volcano.maxHp,
          // Seconds left, derived here so the client never has to know the
          // server's tick rate to render a countdown.
          ticksRemaining: Math.max(0, state.volcano.endTick - state.tick),
        }
      : null,
    // The monster. Synced to everyone for the same reason the volcano is: it is
    // the whole table's problem, everyone has to be able to click it, and the
    // health bar falling is the only feedback that the field is winning.
    //
    // No countdown, because it does not have one — it leaves when it is dead.
    // What replaces it is `attackDamage`, which is the number that actually
    // decides whether to keep swinging or go buy a shield, and which climbs
    // every time a cycle lands.
    monster: state.monster
      ? {
          // Which creature it is. Sent because the CLIENT must not choose: two
          // players looking at different animals in the same match is worse
          // than everyone looking at the same wrong one.
          kind: state.monster.kind,
          hp: state.monster.hp,
          maxHp: state.monster.maxHp,
          attackDamage: state.monster.attackDamage,
          /** Ticks until its next swing — the shield-buying clock. */
          ticksUntilAttack: Math.max(0, state.monster.nextAttackTick - state.tick),
          damage: { ...state.monster.damage },
        }
      : null,
    // Party Mode: the minigame in front of the table, or null. Synced to
    // everyone because it IS everyone's — the banner, the countdown and who has
    // already finished are all shared facts.
    party: state.party ? partyForWire(match, state.party) : null,
    // What currently holds the middle of the battlefield, by name, or null when
    // it is clear — Magma's volcano, Insects' butterfly, Space's black hole,
    // Light's disc, or the monster. Only one may ever stand there
    // (`engine/centrepiece.ts`).
    //
    // Sent as the ANSWER rather than as the ingredients. The client only needs
    // it to grey out the ultimates the server is about to refuse, and two of
    // the four are not in this payload at all (the black hole and the Light
    // Show reach the client as events). Re-deriving the rule on that side would
    // mean maintaining it twice and getting it wrong in exactly the way it was
    // already wrong: knowing about the two it could see and silently missing
    // the other two.
    centrepiece: standingCentrepiece(match)?.name ?? null,
  });
}

/**
 * Announces the end of a match to everyone in the room: the winner's player id,
 * or null for a draw (no survivors). The client flips to the game-over screen.
 */
export function broadcastMatchEnded(io: Server, match: Match): void {
  // `winnerId` is kept alongside the full result so an older client still
  // understands the one fact it was built to read.
  const result = buildMatchResult(match);
  io.to(match.roomCode).emit("match:ended", { winnerId: match.winnerId, result });

  // ⚠️ NOT awaited, and that is the point. The players already have their
  // result on screen; persisting it is bookkeeping that happens afterwards.
  // Awaiting a database here would let a slow Postgres hold up the end of every
  // match, and an unreachable one break it entirely.
  if (result) void recordMatchResult(result);
}

/**
 * Forwards a batch of authoritative gameplay events to everyone in the match's
 * room (Epic 9). These are the exact events the engine's EventBus emits — the
 * client's Pixi layer visualizes them and never derives gameplay from them.
 * Sent alongside `state:sync`; each event carries its own `tick` for timing.
 * No-op for an empty batch so idle ticks cost nothing.
 */
export function broadcastGameEvents(io: Server, match: Match, events: GameplayEvent[]): void {
  if (events.length === 0) return;
  io.to(match.roomCode).emit("evt:batch", { tick: match.gameState?.tick ?? 0, events });
}
