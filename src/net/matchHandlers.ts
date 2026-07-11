import type { Server, Socket } from "socket.io";
import type { MatchManager } from "../match/MatchManager.js";
import { fail, ok, respond } from "./ack.js";
import { broadcastGameState } from "./gameSync.js";
import {
  buyCitizen,
  buyShield,
  citizenCost,
  repairCastle,
  repairCost,
  unlockOrUpgradeAbility,
} from "../engine/purchases.js";
import { activateAbility } from "../engine/abilities.js";
import { ALL_ABILITIES } from "../data/abilitiesRegistry.js";
import { selectTarget } from "../engine/targeting.js";
import type { TransactionResult } from "../engine/transactions.js";

export interface MatchDeps {
  matches: MatchManager;
}

/**
 * In-match gameplay intent handlers. Purchases are validated and applied
 * server-authoritatively, then the updated state is broadcast.
 *
 * (Purchases are processed immediately for now; routing intents through the
 * tick loop's drain phase is a later refinement — see GAME_TICK.md.)
 */
export function registerMatchHandlers(
  io: Server,
  socket: Socket,
  deps: MatchDeps,
): void {
  const { matches } = deps;

  // Ability casting (SOCKET_EVENTS.md §3.1): validate and resolve through the
  // shared ability pipeline, then broadcast the updated state to the room.
  socket.on(
    "match:useAbility",
    (
      payload: {
        abilityId?: unknown;
        targetId?: unknown;
        targetIds?: unknown;
        chargesToUse?: unknown;
      },
      ack: unknown,
    ) => {
      const roomCode =
        typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
      const playerId =
        typeof socket.data.playerId === "string" ? socket.data.playerId : null;
      if (!roomCode || !playerId) {
        respond(ack, fail("INVALID_PHASE", "Not in a match"));
        return;
      }

      const match = matches.getMatch(roomCode);
      const player = match?.gameState?.getPlayer(playerId);
      if (!match || !player) {
        respond(ack, fail("ROOM_NOT_FOUND", "No active match"));
        return;
      }

      const abilityId =
        typeof payload?.abilityId === "string" ? payload.abilityId : "";
      const ability = ALL_ABILITIES[abilityId];
      if (!ability) {
        respond(ack, fail("INVALID_PAYLOAD", "Unknown ability"));
        return;
      }

      // Abilities must be bought before they can be cast (unlock = 50% of cost).
      if (!player.unlocked[abilityId]) {
        respond(ack, fail("NOT_ACTIVATABLE", "Ability not unlocked"));
        return;
      }

      const targetId =
        typeof payload?.targetId === "string" ? payload.targetId : undefined;
      const targetIds = Array.isArray(payload?.targetIds)
        ? payload.targetIds.filter((t): t is string => typeof t === "string")
        : undefined;
      const chargesToUse =
        typeof payload?.chargesToUse === "number" &&
        Number.isFinite(payload.chargesToUse)
          ? Math.floor(payload.chargesToUse)
          : undefined;

      const result = activateAbility(match, player, ability, {
        targetId,
        targetIds,
        chargesToUse,
      });
      if (!result.ok) {
        respond(ack, fail(result.error ?? "INVALID_TRANSACTION", "Cast failed"));
        return;
      }

      broadcastGameState(io, match);
      respond(
        ack,
        ok({
          accepted: true,
          cooldownRemaining: player.cooldowns[abilityId] ?? 0,
          tick: match.gameState!.tick,
        }),
      );
    },
  );

  socket.on("match:buy", (payload: { purchaseId?: unknown }, ack: unknown) => {
    const roomCode =
      typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    const playerId =
      typeof socket.data.playerId === "string" ? socket.data.playerId : null;
    if (!roomCode || !playerId) {
      respond(ack, fail("INVALID_PHASE", "Not in a match"));
      return;
    }

    const match = matches.getMatch(roomCode);
    const player = match?.gameState?.getPlayer(playerId);
    if (!match || !player) {
      respond(ack, fail("ROOM_NOT_FOUND", "No active match"));
      return;
    }

    const purchaseId =
      typeof payload?.purchaseId === "string" ? payload.purchaseId : "";

    let result: TransactionResult;
    let data: Record<string, number>;
    switch (purchaseId) {
      case "citizen":
        result = buyCitizen(match, player);
        data = {
          citizens: player.economy.citizens,
          currency: player.economy.currency,
          nextCost: citizenCost(player), // scaled cost of the next one
        };
        break;
      case "repair":
        result = repairCastle(match, player);
        data = {
          castleHp: player.castle.hp,
          currency: player.economy.currency,
          nextRepairCost: repairCost(player), // scaled cost of the next repair
        };
        break;
      case "shield":
        result = buyShield(match, player);
        data = {
          shield: player.castle.shield,
          currency: player.economy.currency,
        };
        break;
      default:
        respond(ack, fail("INVALID_TRANSACTION", "Unknown purchase"));
        return;
    }

    if (!result.ok) {
      respond(ack, fail(result.error ?? "INVALID_TRANSACTION", "Purchase failed"));
      return;
    }

    // Reflect the change to everyone in the match.
    broadcastGameState(io, match);
    respond(ack, ok(data));
  });

  // Target selection (tickets #61–#63): choose another active kingdom as this
  // player's current target. Validated server-authoritatively; on success the
  // updated target is broadcast so clients stay synchronized (#63).
  socket.on("match:target", (payload: { targetId?: unknown }, ack: unknown) => {
    const roomCode =
      typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    const playerId =
      typeof socket.data.playerId === "string" ? socket.data.playerId : null;
    if (!roomCode || !playerId) {
      respond(ack, fail("INVALID_PHASE", "Not in a match"));
      return;
    }

    const match = matches.getMatch(roomCode);
    const player = match?.gameState?.getPlayer(playerId);
    if (!match || !player) {
      respond(ack, fail("ROOM_NOT_FOUND", "No active match"));
      return;
    }

    // `targetId` must be a player id, or null to clear the current target.
    const raw = payload?.targetId;
    const targetId =
      raw === null ? null : typeof raw === "string" ? raw : undefined;
    if (targetId === undefined) {
      respond(ack, fail("INVALID_PAYLOAD", "targetId must be a string or null"));
      return;
    }

    const result = selectTarget(match, player, targetId);
    if (!result.ok) {
      respond(ack, fail(result.error ?? "INVALID_TARGET", "Target selection failed"));
      return;
    }

    // Broadcast the updated target to the room so clients stay synchronized (#63).
    broadcastGameState(io, match);
    respond(ack, ok({ targetId: player.target }));
  });

  // Ability unlocks and upgrades: unlock costs 50% of ability's cast cost.
  socket.on("match:upgrade", (payload: { abilityId?: unknown }, ack: unknown) => {
    const roomCode =
      typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    const playerId =
      typeof socket.data.playerId === "string" ? socket.data.playerId : null;
    if (!roomCode || !playerId) {
      respond(ack, fail("INVALID_PHASE", "Not in a match"));
      return;
    }

    const match = matches.getMatch(roomCode);
    const player = match?.gameState?.getPlayer(playerId);
    if (!match || !player) {
      respond(ack, fail("ROOM_NOT_FOUND", "No active match"));
      return;
    }

    const abilityId =
      typeof payload?.abilityId === "string" ? payload.abilityId : "";

    const result = unlockOrUpgradeAbility(match, player, abilityId);
    if (!result.ok) {
      respond(ack, fail(result.error ?? "INVALID_TRANSACTION", "Upgrade failed"));
      return;
    }

    // Reflect the change to everyone in the match.
    broadcastGameState(io, match);
    respond(ack, ok({
      level: result.level ?? 0,
      currency: player.economy.currency,
    }));
  });
}
