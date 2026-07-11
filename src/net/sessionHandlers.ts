import type { Socket } from "socket.io";
import { ok, respond } from "./ack.js";
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
}
