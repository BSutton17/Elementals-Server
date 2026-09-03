import type { Server, Socket } from "socket.io";
import type { MatchManager } from "../match/MatchManager.js";
import { fail, ok, respond } from "./ack.js";
import { broadcastGameState } from "./gameSync.js";
import { actOnParty, PARTY_GAMES, startParty } from "../engine/party/index.js";
import type { PartyGameId } from "../engine/party/types.js";
import type { Match } from "../match/Match.js";
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
   * ⚠️ TWO WAYS IN, AND BOTH END AT HOST ONLY.
   *
   *   - A development build, over loopback. The permanent one: a dev build
   *     exposed on a LAN is still not a build where a guest may do this.
   *   - An admin, anywhere. TEMPORARY — see ADMIN_MAY_LAUNCH_DEPLOYED, which
   *     is the one line to delete when the sixteen have been checked.
   *
   * Either way the room's owner, not any seat, and every check is repeated
   * here on the actual start — so the panel being rendered by accident, or
   * forced open in devtools, achieves nothing.
   *
   * Testing sixteen minigames by waiting for a one-in-ten roll every
   * twenty-five seconds is not testing them, which is why this exists.
   */
  socket.on("party:debug", (payload: { gameId?: unknown }, ack: unknown) => {
    if (!mayLaunch(socket)) {
      respond(ack, fail("NOT_ALLOWED", "Not available"));
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
    // ⚠️ A RUNNING SESSION IS CANCELLED HERE, NOT AN ERROR — IN THIS HANDLER
    // ONLY. Checking sixteen minigames means starting sixteen of them in a row,
    // and most run twenty to thirty seconds; refusing until the last one has
    // finished turns a five-minute pass into half an hour of waiting for a
    // maze nobody is solving. Ordinary play cannot reach this line: the roll
    // never starts one while another stands.
    if (here.match.gameState) here.match.gameState.party = null;

    const session = startParty(here.match, gameId as PartyGameId);
    if (!session) {
      respond(ack, fail("INVALID_PHASE", startRefusal(here.match, gameId) ?? "Could not start it"));
      return;
    }
    logger.info("Party debug start", { gameId, roomCode: here.match.roomCode });
    broadcastGameState(io, here.match);
    respond(ack, ok({ gameId }));
  });

  /**
   * The list, so the debug panel never hardcodes one that has been renamed.
   *
   * Each entry says whether it would start RIGHT NOW and why not, so a tester
   * looking at a button that does nothing can tell "broken" apart from
   * "Haunted has nobody to raise".
   */
  socket.on("party:debugList", (_payload: unknown, ack: unknown) => {
    const available = mayLaunch(socket);
    const here = seat();
    respond(
      ack,
      ok({
        available,
        games: available
          ? PARTY_GAMES.map((g) => ({
              id: g.id,
              description: g.description,
              reason: here ? startRefusal(here.match, g.id) : null,
            }))
          : [],
      }),
    );
  });
}

/**
 * ⚠️ TEMPORARY, AND MEANT TO BE DELETED. Set false to restore the original
 * fence: development build, over loopback, host only. It is true while the
 * sixteen minigames are being checked on the deployed build — they have to be
 * tried on a real phone over a real network, and a one-in-ten roll every
 * twenty-five seconds is not a way to reach the sixteenth one.
 *
 * What it costs while it is on: an admin, and only an admin, who is also the
 * host of the room, can start a minigame in a room they are already running.
 * That is a narrower power than the admin room rules next door in
 * lobbyHandlers, which is why this is an acceptable thing to leave on for a
 * few days and not an acceptable thing to leave on forever.
 */
const ADMIN_MAY_LAUNCH_DEPLOYED = true;

/** Whether this socket is allowed to start minigames by hand. */
function mayLaunch(socket: Socket): boolean {
  // The permanent fence: a development build, from this machine.
  if (!config.isProduction && isLoopback(socket)) return true;
  // The temporary one.
  return ADMIN_MAY_LAUNCH_DEPLOYED && socket.data.admin === true;
}

/** Why a minigame will not start, in words a person can read, or null. */
function startRefusal(match: Match, gameId: string): string | null {
  const game = PARTY_GAMES.find((g) => g.id === gameId);
  if (!game) return "No such minigame";
  // The only games that refuse outright are the conditional ones — Haunted
  // with nobody dead to raise.
  if (game.canStart?.(match) === false) {
    return gameId === "haunted" ? "Needs an eliminated kingdom to raise" : "Not available yet";
  }
  const living = match.gameState?.getPlayers().filter((p) => !p.eliminated).length ?? 0;
  if (living === 0) return "Nobody left to play it";
  return null;
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
