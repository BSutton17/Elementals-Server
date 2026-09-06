import type { Server, Socket } from "socket.io";
import type { MatchManager } from "../match/MatchManager.js";
import { fail, ok, respond } from "./ack.js";
import { broadcastGameState } from "./gameSync.js";
import { actOnParty } from "../engine/party/index.js";

export interface PartyDeps {
  matches: MatchManager;
}

/**
 * Party Mode over the wire: one event.
 *
 * `party:act` — a move in the running minigame. The client says what the player
 * DID; this side decides what it was worth.
 *
 * There were also `party:debug` and `party:debugList`, which let the host start
 * any minigame on demand. They existed to check the sixteen without waiting on a
 * one-in-ten roll every twenty-five seconds, were always marked temporary, and
 * have been removed now that the checking is done — along with the admin
 * allowance that briefly opened them on the deployed build. A minigame starts
 * one way now: the roll.
 */
export function registerPartyHandlers(io: Server, socket: Socket, deps: PartyDeps): void {
  const { matches } = deps;

  const seat = () => {
    const roomCode = typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    const playerId = typeof socket.data.playerId === "string" ? socket.data.playerId : null;
    if (!roomCode || !playerId) return null;
    const match = matches.getMatch(roomCode);
    const player = match?.gameState?.getPlayer(playerId);
    if (!match || !player) return null;
    return { match, player };
  };

  socket.on("party:act", (payload: { action?: unknown }, ack: unknown) => {
    const here = seat();
    if (!here) {
      respond(ack, fail("ROOM_NOT_FOUND", "No active match"));
      return;
    }
    const action = payload?.action;
    if (typeof action !== "object" || action === null || typeof (action as { type?: unknown }).type !== "string") {
      respond(ack, fail("INVALID_INPUT", "An action needs a type"));
      return;
    }

    const result = actOnParty(here.match, here.player, action as { type: string });
    if (!result.ok) {
      respond(ack, fail("INVALID_TRANSACTION", result.error ?? "Refused"));
      return;
    }
    // Broadcast rather than reply-only: a minigame is a shared thing, and who
    // has already finished changes what everybody else is looking at.
    broadcastGameState(io, here.match);
    respond(ack, ok({}));
  });
}
