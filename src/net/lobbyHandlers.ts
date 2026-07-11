import type { Server, Socket } from "socket.io";
import type { GameLoopManager } from "../engine/GameLoopManager.js";
import type { MatchManager } from "../match/MatchManager.js";
import type { MatchPlayer } from "../match/types.js";
import type { ReconnectionManager } from "./ReconnectionManager.js";
import { fail, ok, respond } from "./ack.js";
import { broadcastLobbyUpdate, removePlayerFromMatch } from "./lobbyRoom.js";
import { ensureSessionId } from "./sessionHandlers.js";
import { buildMatchSnapshot } from "../match/snapshot.js";
import { createMatchConfig } from "../match/matchConfig.js";
import { isKingdomId } from "../data/kingdoms.js";
import { logger } from "../util/logger.js";

export interface LobbyDeps {
  matches: MatchManager;
  reconnection: ReconnectionManager;
  gameLoops: GameLoopManager;
}

const MAX_NAME_LENGTH = 24;

/** Validates and normalizes a player-supplied display name. */
function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

/**
 * Registers lobby/room event handlers for a connected socket. Turns client
 * intents into operations on the shared MatchManager and replies via the ack
 * envelope (see SOCKET_EVENTS.md).
 */
export function registerLobbyHandlers(
  io: Server,
  socket: Socket,
  deps: LobbyDeps,
): void {
  const { matches, reconnection, gameLoops } = deps;

  // Host a new match: generate a unique room code and seat the caller as host.
  socket.on("lobby:create", (payload: { name?: unknown }, ack: unknown) => {
    const name = normalizeName(payload?.name);
    if (name === null) {
      respond(ack, fail("INVALID_PAYLOAD", "A valid player name is required"));
      return;
    }

    // Guard against duplicate/rapid requests on a socket already in a room.
    if (typeof socket.data.roomCode === "string") {
      respond(ack, fail("ALREADY_IN_ROOM", "Already in a room"));
      return;
    }

    const match = matches.createMatch();
    const player: MatchPlayer = {
      id: ensureSessionId(socket),
      socketId: socket.id,
      name,
      kingdomId: null,
      ready: false,
      connected: true,
    };
    match.addPlayer(player);
    match.hostId = player.id;

    socket.data.playerId = player.id;
    socket.data.roomCode = match.roomCode;
    void socket.join(match.roomCode);

    logger.info("Match created", {
      roomCode: match.roomCode,
      hostId: player.id,
      socketId: socket.id,
    });
    broadcastLobbyUpdate(io, match);

    respond(
      ack,
      ok({
        roomCode: match.roomCode,
        playerId: player.id,
        match: match.serialize(),
      }),
    );
  });

  // Join an existing match by room code. An optional `playerId` lets a returning
  // player reconnect to their existing seat instead of creating a duplicate.
  socket.on(
    "lobby:join",
    (payload: { name?: unknown; roomCode?: unknown }, ack: unknown) => {
      const name = normalizeName(payload?.name);
      if (name === null) {
        respond(ack, fail("INVALID_PAYLOAD", "A valid player name is required"));
        return;
      }

      const roomCode =
        typeof payload?.roomCode === "string" ? payload.roomCode.trim() : "";
      if (roomCode === "") {
        respond(ack, fail("INVALID_PAYLOAD", "A room code is required"));
        return;
      }

      // Guard against repeated requests on a socket that is already in a room.
      if (typeof socket.data.roomCode === "string") {
        respond(ack, fail("ALREADY_IN_ROOM", "Already in a room"));
        return;
      }

      const match = matches.getMatch(roomCode);
      if (!match) {
        respond(ack, fail("ROOM_NOT_FOUND", "No match found for that room code"));
        return;
      }
      if (match.phase !== "lobby") {
        respond(ack, fail("INVALID_PHASE", "This match has already started"));
        return;
      }
      if (match.isFull()) {
        respond(ack, fail("ROOM_FULL", `Room is full (max ${match.maxPlayers})`));
        return;
      }

      // This session is already seated (e.g. another socket/tab for the same
      // session) — they should reconnect via `room:reconnect`, not join again.
      const sessionId = ensureSessionId(socket);
      if (match.hasPlayer(sessionId)) {
        respond(
          ack,
          fail("DUPLICATE_JOIN", "This session is already in the room"),
        );
        return;
      }

      const player: MatchPlayer = {
        id: sessionId,
        socketId: socket.id,
        name,
        kingdomId: null,
        ready: false,
        connected: true,
      };
      match.addPlayer(player);

      socket.data.playerId = player.id;
      socket.data.roomCode = match.roomCode;
      void socket.join(match.roomCode);

      logger.info("Player joined match", {
        roomCode: match.roomCode,
        playerId: player.id,
        socketId: socket.id,
      });

      // Notify existing members of the new arrival, then broadcast full state.
      socket.to(match.roomCode).emit("lobby:playerJoined", { player });
      broadcastLobbyUpdate(io, match);

      respond(
        ack,
        ok({
          roomCode: match.roomCode,
          playerId: player.id,
          match: match.serialize(),
        }),
      );
    },
  );

  // Choose an elemental kingdom. Kingdoms are exclusive within a match: no two
  // players may hold the same one. Players may change freely until the match
  // starts (ticket #34).
  socket.on(
    "lobby:selectKingdom",
    (payload: { kingdom?: unknown }, ack: unknown) => {
      const roomCode =
        typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
      const playerId =
        typeof socket.data.playerId === "string" ? socket.data.playerId : null;
      if (!roomCode || !playerId) {
        respond(ack, fail("INVALID_PHASE", "Not in a room"));
        return;
      }

      const kingdom = payload?.kingdom;
      if (!isKingdomId(kingdom)) {
        respond(ack, fail("INVALID_PAYLOAD", "Unknown kingdom"));
        return;
      }

      const match = matches.getMatch(roomCode);
      const player = match?.getPlayer(playerId);
      if (!match || !player) {
        respond(ack, fail("ROOM_NOT_FOUND", "No match found"));
        return;
      }
      if (match.phase !== "lobby") {
        respond(ack, fail("INVALID_PHASE", "Cannot change kingdom after start"));
        return;
      }

      // Enforce exclusivity — reject if another player already holds it.
      const taken = match
        .getPlayers()
        .some((p) => p.id !== playerId && p.kingdomId === kingdom);
      if (taken) {
        respond(ack, fail("KINGDOM_TAKEN", "That kingdom is already taken"));
        return;
      }

      player.kingdomId = kingdom;
      broadcastLobbyUpdate(io, match);
      respond(ack, ok({ kingdom: player.kingdomId }));
    },
  );

  // Toggle lobby ready state.
  socket.on("lobby:ready", (payload: { ready?: unknown }, ack: unknown) => {
    const roomCode =
      typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    const playerId =
      typeof socket.data.playerId === "string" ? socket.data.playerId : null;
    if (!roomCode || !playerId) {
      respond(ack, fail("INVALID_PHASE", "Not in a room"));
      return;
    }
    if (typeof payload?.ready !== "boolean") {
      respond(ack, fail("INVALID_PAYLOAD", "ready must be a boolean"));
      return;
    }

    const match = matches.getMatch(roomCode);
    const player = match?.getPlayer(playerId);
    if (!match || !player) {
      respond(ack, fail("ROOM_NOT_FOUND", "No match found"));
      return;
    }
    if (match.phase !== "lobby") {
      respond(ack, fail("INVALID_PHASE", "Match already started"));
      return;
    }

    player.ready = payload.ready;
    broadcastLobbyUpdate(io, match);
    respond(ack, ok({ ready: player.ready }));
  });

  // Start the match (host only). Rejected unless every connected player is
  // ready and the minimum player count is met (ticket #30). Full gameplay
  // initialization (active phase, tick loop, player state) is a later ticket;
  // this transitions the lobby to the "starting" phase.
  socket.on("lobby:start", (_payload: unknown, ack: unknown) => {
    const roomCode =
      typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    const playerId =
      typeof socket.data.playerId === "string" ? socket.data.playerId : null;
    if (!roomCode || !playerId) {
      respond(ack, fail("INVALID_PHASE", "Not in a room"));
      return;
    }

    const match = matches.getMatch(roomCode);
    if (!match) {
      respond(ack, fail("ROOM_NOT_FOUND", "No match found"));
      return;
    }
    if (!match.isHost(playerId)) {
      respond(ack, fail("NOT_HOST", "Only the host can start the match"));
      return;
    }
    if (match.phase !== "lobby") {
      respond(ack, fail("INVALID_PHASE", "Match already started"));
      return;
    }
    if (!match.canStart()) {
      respond(
        ack,
        fail(
          "NOT_READY",
          "All connected players must be ready with a kingdom selected",
        ),
      );
      return;
    }

    // Initialize the match and transition the lobby into an active game.
    const config = createMatchConfig(match);
    match.start(config);
    logger.info("Match started", { roomCode, playerCount: match.playerCount });

    broadcastLobbyUpdate(io, match);
    io.to(roomCode).emit("match:started", {
      roomCode,
      config,
      players: match.getPlayers(),
      tick: match.tick,
      serverTime: Date.now(),
    });
    // Begin the authoritative game loop for this match.
    gameLoops.start(match);
    respond(ack, ok({ phase: match.phase }));
  });

  // Voluntarily leave a room before the match begins.
  socket.on("lobby:leave", (_payload: unknown, ack: unknown) => {
    const roomCode =
      typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    const playerId =
      typeof socket.data.playerId === "string" ? socket.data.playerId : null;

    // Not in a room — treat as an idempotent no-op.
    if (!roomCode || !playerId) {
      respond(ack, ok({ left: false }));
      return;
    }

    const match = matches.getMatch(roomCode);
    if (!match) {
      socket.data.roomCode = undefined;
      socket.data.playerId = undefined;
      respond(ack, ok({ left: false }));
      return;
    }
    if (match.phase !== "lobby") {
      respond(
        ack,
        fail("INVALID_PHASE", "Cannot leave after the match has started"),
      );
      return;
    }

    void socket.leave(roomCode);
    socket.data.roomCode = undefined;
    socket.data.playerId = undefined;
    // Cancel any grace timer (defensive) and apply shared room cleanup.
    reconnection.cancel(roomCode, playerId);
    removePlayerFromMatch(io, matches, roomCode, playerId, "left");

    logger.info("Player left match", { roomCode, playerId });
    respond(ack, ok({ left: true }));
  });

  // Reconnect to an existing lobby or active match using a session id + room
  // code. Unlike join, this works in any phase and reattaches an existing seat.
  socket.on(
    "room:reconnect",
    (payload: { sessionId?: unknown; roomCode?: unknown }, ack: unknown) => {
      const sessionId =
        typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
      const roomCode =
        typeof payload?.roomCode === "string" ? payload.roomCode.trim() : "";
      if (sessionId === "" || roomCode === "") {
        respond(ack, fail("INVALID_PAYLOAD", "A session id and room code are required"));
        return;
      }

      if (typeof socket.data.roomCode === "string") {
        respond(ack, fail("ALREADY_IN_ROOM", "Already in a room"));
        return;
      }

      const match = matches.getMatch(roomCode);
      if (!match) {
        respond(ack, fail("ROOM_NOT_FOUND", "No match found for that room code"));
        return;
      }

      const player = match.getPlayer(sessionId);
      if (!player) {
        respond(ack, fail("SESSION_NOT_IN_ROOM", "That session is not part of this room"));
        return;
      }
      if (player.connected) {
        respond(ack, fail("DUPLICATE_JOIN", "This player is already connected"));
        return;
      }

      // Reattach the disconnected seat and cancel the pending grace removal.
      reconnection.cancel(roomCode, player.id);
      player.socketId = socket.id;
      player.connected = true;
      socket.data.sessionId = sessionId;
      socket.data.playerId = player.id;
      socket.data.roomCode = roomCode;
      void socket.join(roomCode);

      logger.info("Player reconnected", {
        roomCode,
        playerId: player.id,
        socketId: socket.id,
      });
      // Tell the room the player is back...
      broadcastLobbyUpdate(io, match);
      // ...and send the reconnecting client the full authoritative snapshot so
      // it can restore its own state and the current match state, and resume
      // seamlessly (see SOCKET_EVENTS.md §4 `state:full`).
      socket.emit("state:full", buildMatchSnapshot(match, player.id));

      respond(
        ack,
        ok({
          roomCode,
          playerId: player.id,
          match: match.serialize(),
          reconnected: true,
        }),
      );
    },
  );
}
