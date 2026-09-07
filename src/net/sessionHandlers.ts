import type { Socket } from "socket.io";
import { ok, respond } from "./ack.js";
import { readSessionToken } from "../auth/sessions.js";
import { isAdmin } from "../db/admin.js";
import { createId } from "../util/id.js";
import { logger } from "../util/logger.js";
import { fastRoom, slowRoom } from "./gameSync.js";

/**
 * Returns the socket's session id, assigning a fresh one if it does not have
 * one yet. The session id is the player's persistent identity: it survives
 * Socket.IO reconnects (a new socket, restored via `conn:identify`), so the
 * server identifies players by session rather than by socket connection.
 */
export function ensureSessionId(socket: Socket): string {
  if (typeof socket.data.sessionId !== "string") {
    socket.data.sessionId = createId();
  }
  return socket.data.sessionId as string;
}

/** Registers the session identification handler and assigns an initial session. */
export function registerSessionHandlers(socket: Socket): void {
  // Give every connection a session immediately.
  ensureSessionId(socket);

  // The client may present a previously-issued session id to restore identity
  // after a reconnect; otherwise it keeps the one assigned on connect.
  socket.on("conn:identify", (payload: { sessionId?: unknown }, ack: unknown) => {
    if (typeof payload?.sessionId === "string" && payload.sessionId.trim() !== "") {
      socket.data.sessionId = payload.sessionId.trim();
    } else {
      ensureSessionId(socket);
    }
    logger.debug("Session identified", {
      socketId: socket.id,
      sessionId: socket.data.sessionId,
    });
    respond(ack, ok({ sessionId: socket.data.sessionId }));
  });

  /**
   * Attaches the signed-in ACCOUNT to this socket.
   *
   * ⚠️ THE SESSION ID IS NOT AN ACCOUNT. It is an anonymous handle that
   * survives reconnects and says nothing about who the player is — a guest has
   * one. Anything that has to be decided per ACCOUNT (so far: whether this
   * player may change a room's rules) needs the signed JWT presented over the
   * socket as well, because socket events never pass through the HTTP layer
   * that reads the Authorization header.
   *
   * A bad or absent token is not an error: it means "playing as a guest", which
   * is a supported way to play. It simply leaves the socket without an account.
   */
  socket.on("conn:authenticate", (payload: { token?: unknown }, ack: unknown) => {
    const token = typeof payload?.token === "string" ? payload.token.trim() : "";
    const accountId = token === "" ? null : readSessionToken(token);
    socket.data.accountId = accountId ?? undefined;
    if (accountId === null) {
      respond(ack, ok({ signedIn: false, admin: false }));
      return;
    }
    void isAdmin(accountId).then((admin) => {
      socket.data.admin = admin;
      logger.debug("Socket authenticated", { socketId: socket.id, admin });
      respond(ack, ok({ signedIn: true, admin }));
    });
  });

  /**
   * How often this client wants to be told the state of the match.
   *
   * ⚠️ A PROPERTY OF THE DEVICE, NOT OF THE PLAYER OR THE MATCH. The simulation
   * runs at a fixed rate for everybody and nothing here changes it; this only
   * decides how often the result is sent to THIS socket. A phone that overheats
   * can ask for half as many updates without altering anybody else's game.
   *
   * ⚠️ AND IT IS SUSPENDED DURING A MINIGAME. Reaction Test is scored from when
   * a press arrives; a client told about the green light late would post a
   * worse time for choosing to save battery. `broadcastGameState` sends every
   * client every sync for as long as a session is live — see `slowClientsGetThis`.
   *
   * Room membership rather than a flag on the socket, because the broadcast has
   * to be able to address "everyone except the slow ones" in one emit.
   */
  socket.on("conn:setSyncRate", (payload: { rate?: unknown }, ack: unknown) => {
    const rate = payload?.rate === "reduced" ? "reduced" : "normal";
    const roomCode =
      typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    socket.data.syncRate = rate;

    // Applied to whichever room the socket is in now; joining a room later
    // re-applies it (see `applySyncRate`).
    if (roomCode) applySyncRate(socket, roomCode);
    respond(ack, ok({ rate }));
  });
}

/**
 * Re-applies a socket's chosen cadence after it joins a room.
 *
 * The preference is set once, near start-up, and rooms are joined and left many
 * times after that — so without this a player who set it in the menu would
 * silently get full-rate updates in every match they went on to play.
 */
export function applySyncRate(socket: Socket, roomCode: string): void {
  const reduced = socket.data.syncRate === "reduced";
  // Both memberships are set explicitly, and the unwanted one is left: this
  // runs again every time the socket joins a room, and a stale membership from
  // a previous match would decide the cadence of the next one.
  if (reduced) {
    void socket.leave(fastRoom(roomCode));
    void socket.join(slowRoom(roomCode));
  } else {
    void socket.leave(slowRoom(roomCode));
    void socket.join(fastRoom(roomCode));
  }
}
