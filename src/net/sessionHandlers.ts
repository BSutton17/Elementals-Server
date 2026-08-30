import type { Socket } from "socket.io";
import { ok, respond } from "./ack.js";
import { readSessionToken } from "../auth/sessions.js";
import { isAdmin } from "../db/admin.js";
import { createId } from "../util/id.js";
import { logger } from "../util/logger.js";

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
}
