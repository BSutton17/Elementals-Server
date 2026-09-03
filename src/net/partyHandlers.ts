import type { Server, Socket } from "socket.io";
import type { MatchManager } from "../match/MatchManager.js";
import { fail, ok, respond } from "./ack.js";
import { broadcastGameState } from "./gameSync.js";
import { actOnParty, PARTY_GAMES, startParty } from "../engine/party/index.js";
import type { PartyGameId } from "../engine/party/types.js";
import { config } from "../config/index.js";
import { logger } from "../util/logger.js";

export interface PartyDeps {
  matches: MatchManager;
}

/**
 * Party Mode over the wire.
 *
 * Two events, and they are not the same kind of thing at all:
 *
 *   `party:act`   — a move in the running minigame. The client says what the
 *                   player DID; this side decides what it was worth.
 *   `party:debug` — start a named minigame right now. A development tool, and
 *                   fenced as one (see below).
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

  /**
   * Start a named minigame immediately.
   *
   * ⚠️ THREE LOCKS, AND ALL THREE ARE NEEDED.
   *
   *   1. DEVELOPMENT ONLY. Refused outright when NODE_ENV is production, so
   *      shipping this by accident cannot hand a live table a maze on demand.
   *   2. LOOPBACK ONLY. The socket's address has to be localhost — a dev build
   *      exposed on a LAN is still not a build where a guest may do this.
   *   3. HOST ONLY. Even locally it is the room's owner, not any seat.
   *
   * Testing fourteen minigames by waiting for a one-in-ten roll every
   * twenty-five seconds is not testing them, so this exists; it is fenced hard
   * enough that its existence costs nothing.
   */
  socket.on("party:debug", (payload: { gameId?: unknown }, ack: unknown) => {
    if (config.isProduction) {
      respond(ack, fail("NOT_ALLOWED", "Not available"));
      return;
    }
    if (!isLoopback(socket)) {
      respond(ack, fail("NOT_ALLOWED", "Local play only"));
      return;
    }
    const here = seat();
    if (!here) {
      respond(ack, fail("ROOM_NOT_FOUND", "No active match"));
      return;
    }
    if (!here.match.isHost(here.player.id)) {
      respond(ack, fail("NOT_HOST", "Only the host can start one"));
      return;
    }

    const gameId = typeof payload?.gameId === "string" ? payload.gameId : "";
    if (!PARTY_GAMES.some((g) => g.id === gameId)) {
      respond(ack, fail("INVALID_INPUT", `Unknown minigame: ${gameId}`));
      return;
    }
    if (here.match.gameState?.party) {
      respond(ack, fail("INVALID_PHASE", "One is already running"));
      return;
    }

    const session = startParty(here.match, gameId as PartyGameId);
    if (!session) {
      respond(ack, fail("INVALID_PHASE", "Could not start it"));
      return;
    }
    logger.info("Party debug start", { gameId, roomCode: here.match.roomCode });
    broadcastGameState(io, here.match);
    respond(ack, ok({ gameId }));
  });

  /** The list, so the debug panel never hardcodes one that has been renamed. */
  socket.on("party:debugList", (_payload: unknown, ack: unknown) => {
    const available = !config.isProduction && isLoopback(socket);
    respond(
      ack,
      ok({
        available,
        games: available
          ? PARTY_GAMES.map((g) => ({ id: g.id, description: g.description }))
          : [],
      }),
    );
  });
}

/**
 * Whether this socket came from the machine the server is running on.
 *
 * IPv4 and IPv6 loopback, plus the IPv4-mapped form Node reports when a
 * dual-stack listener accepts a v4 connection — miss that one and the check
 * fails on exactly the setup most people develop with.
 */
function isLoopback(socket: Socket): boolean {
  const address = socket.handshake.address ?? "";
  return (
    address === "::1" ||
    address === "127.0.0.1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}
