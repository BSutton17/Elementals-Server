import type { Server, Socket } from "socket.io";
import type { GameLoopManager } from "../engine/GameLoopManager.js";
import type { MatchManager } from "../match/MatchManager.js";
import type { BotDifficulty, MatchPlayer } from "../match/types.js";
import type { ReconnectionManager } from "./ReconnectionManager.js";
import { fail, ok, respond } from "./ack.js";
import { broadcastLobbyUpdate, removePlayerFromMatch } from "./lobbyRoom.js";
import { ensureSessionId } from "./sessionHandlers.js";
import { buildMatchSnapshot } from "../match/snapshot.js";
import { createMatchConfig } from "../match/matchConfig.js";
import { isKingdomId, KINGDOM_IDS } from "../data/kingdoms.js";
import type { PerkId } from "../data/perks.js";
import {
  PERK_IDS,
  hasFullPerkSelection,
  normalizePerks,
  perksAllowedFor,
} from "../data/perks.js";
import { MATCH } from "../data/balance.js";
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
 * Drops any perks the player's CURRENT kingdom does not entitle them to.
 *
 * The allowance is per-kingdom — Kitsune's "Three tailed fox" grants one more
 * than everyone else — so switching away from Kitsune (or to spectating) has to
 * give the extra perk back. Without this the seat keeps three perks it is no
 * longer owed AND can never ready up, since the ready gate wants the count to
 * match the allowance exactly.
 *
 * The earliest picks are kept: they were chosen first, and dropping the most
 * recent selection is the least surprising thing to undo.
 */
function trimPerksToAllowance(player: MatchPlayer): void {
  const allowed = perksAllowedFor(player.kingdomId);
  const perks = player.perks ?? [];
  if (perks.length > allowed) player.perks = perks.slice(0, allowed);
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
      perks: [],
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
      // The sentinel "spectator" opts this seat out of playing — no kingdom,
      // watches only. Any other value must be a real kingdom id.
      const wantsSpectate = kingdom === "spectator";
      if (!wantsSpectate && !isKingdomId(kingdom)) {
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

      if (wantsSpectate) {
        player.spectator = true;
        player.kingdomId = null;
        trimPerksToAllowance(player);
        broadcastLobbyUpdate(io, match);
        respond(ack, ok({ spectator: true }));
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

      // Cap kingdom-playing participants: if the max already hold a kingdom and
      // this seat isn't one of them, it can only spectate.
      const otherActive = match
        .getPlayers()
        .filter((p) => p.id !== playerId && !p.spectator && p.kingdomId !== null).length;
      if (otherActive >= MATCH.MAX_ACTIVE_PLAYERS) {
        respond(
          ack,
          fail("PLAYERS_FULL", `Only ${MATCH.MAX_ACTIVE_PLAYERS} players can play — join as a spectator`),
        );
        return;
      }

      player.spectator = false;
      player.kingdomId = kingdom;
      trimPerksToAllowance(player);
      broadcastLobbyUpdate(io, match);
      respond(ack, ok({ kingdom: player.kingdomId }));
    },
  );

  // Choose the player's perks — flat match-long bonuses picked alongside the
  // kingdom. Unlike kingdoms these are NOT exclusive: any number of players may
  // run the same perk. The client sends the whole selection each time (0–2 ids)
  // so toggling one off is just a shorter list; a full set is required to ready.
  socket.on("lobby:selectPerks", (payload: { perks?: unknown }, ack: unknown) => {
    const roomCode =
      typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    const playerId =
      typeof socket.data.playerId === "string" ? socket.data.playerId : null;
    if (!roomCode || !playerId) {
      respond(ack, fail("INVALID_PHASE", "Not in a room"));
      return;
    }

    // The room is resolved FIRST: the allowance depends on which kingdom this
    // player has chosen (Kitsune may pick three), so the payload cannot be
    // validated until we know who is asking.
    const match = matches.getMatch(roomCode);
    const player = match?.getPlayer(playerId);
    if (!match || !player) {
      respond(ack, fail("ROOM_NOT_FOUND", "No match found"));
      return;
    }

    const perks = normalizePerks(payload?.perks, player.kingdomId);
    if (perks === null) {
      respond(
        ack,
        fail(
          "INVALID_PAYLOAD",
          `Pick up to ${perksAllowedFor(player.kingdomId)} distinct perks`,
        ),
      );
      return;
    }
    if (match.phase !== "lobby") {
      respond(ack, fail("INVALID_PHASE", "Cannot change perks after start"));
      return;
    }

    player.perks = perks;
    // Dropping below a full set un-readies the player, so they can never be
    // carried into a match on a selection they've since taken apart.
    if (player.ready && !hasFullPerkSelection(player.perks, player.kingdomId)) {
      player.ready = false;
    }
    broadcastLobbyUpdate(io, match);
    respond(ack, ok({ perks: player.perks }));
  });

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
    // A player can only ready up once their loadout is settled: a kingdom and
    // a full set of perks. Spectators bring neither and ready freely.
    if (payload.ready && !player.spectator) {
      if (player.kingdomId === null) {
        respond(ack, fail("NOT_READY", "Select a kingdom first"));
        return;
      }
      if (!hasFullPerkSelection(player.perks, player.kingdomId)) {
        respond(
          ack,
          fail(
            "NOT_READY",
            `Select ${perksAllowedFor(player.kingdomId)} perks first`,
          ),
        );
        return;
      }
    }

    player.ready = payload.ready;
    broadcastLobbyUpdate(io, match);
    respond(ack, ok({ ready: player.ready }));
  });

  // Start the match (host only). Rejected unless every connected player is
  // ready and the minimum player count is met (ticket #30). Full gameplay
  // initialization (active phase, tick loop, player state) is a later ticket;
  // this transitions the lobby to the "starting" phase.
  /**
   * Host-only room setting: whether an eliminated player keeps seeing every
   * surviving kingdom's health. Lobby phase only — flipping it mid-match would
   * change what players can see out from under them.
   */
  socket.on("lobby:setRules", (payload: { eliminatedSeeAllHealth?: unknown }, ack: unknown) => {
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
      respond(ack, fail("NOT_HOST", "Only the host can change the rules"));
      return;
    }
    if (match.phase !== "lobby") {
      respond(ack, fail("INVALID_PHASE", "The match has already started"));
      return;
    }
    if (typeof payload?.eliminatedSeeAllHealth !== "boolean") {
      respond(ack, fail("INVALID_INPUT", "eliminatedSeeAllHealth must be a boolean"));
      return;
    }

    match.eliminatedSeeAllHealth = payload.eliminatedSeeAllHealth;
    broadcastLobbyUpdate(io, match);
    respond(ack, ok({ eliminatedSeeAllHealth: match.eliminatedSeeAllHealth }));
  });

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
          "All connected players must be ready with a kingdom and a full perk selection",
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


  // ── Bots ──────────────────────────────────────────────────────────────────
  //
  // A bot is a normal MatchPlayer with `isBot` set. It occupies a real seat,
  // counts toward capacity, and must satisfy the same start conditions as a
  // person — so the server picks its kingdom and perks on its behalf, because
  // `canStart()` refuses a seat without them and a bot cannot click.
  //
  // `connected: true` is deliberate and load-bearing: `canStart()` only counts
  // connected seats, so a bot marked disconnected would be silently skipped by
  // the readiness gate and the match would start with an unready seat.

const BOT_NAMES = [
  "Ember",
  "Cinder",
  "Frost",
  "Gale",
  "Quartz",
  "Nøkken",
  "Thistle",
  "Onyx",
  "Blaze",
  "Nimbus",
  "Rook",
  "Bramble",
  "Sparx",
  "Mistral",
  "Flint",
  "Echo",
  "Anubis",
  "Pebble",
  "Zephyr",
  "Moss",
  "Bo Longma",
  "Ash",
  "Tempest",
  "Vex",
  "Tundra",
  "Kydos",
  "Ky'el"
];

  function isBotDifficulty(value: unknown): value is BotDifficulty {
    return value === "easy" || value === "medium" || value === "hard";
  }

  /**
   * A random kingdom nobody in the lobby has taken, or null when all are gone.
   *
   * Random rather than first-free: taking them in roster order meant the first
   * bot was always Water, the second always Fire, and a host adding three bots
   * got the same three kingdoms every single game. Chosen from the free ones
   * only, so it can never collide with a human's pick or another bot's.
   */
  function freeKingdom(match: ReturnType<MatchManager["getMatch"]>): string | null {
    if (!match) return null;
    const taken = new Set(match.getPlayers().map((p) => p.kingdomId).filter(Boolean));
    const free = KINGDOM_IDS.filter((k) => !taken.has(k));
    if (free.length === 0) return null;
    return free[Math.floor(Math.random() * free.length)]!;
  }

  /**
   * A random legal perk selection.
   *
   * Taking the first N off the canonical list gave every bot in every lobby the
   * identical loadout, which is both dull to play against and quietly
   * misleading: a room of three bots looked like three different opponents and
   * played like one. Shuffled rather than sampled with repeats, so the draw is
   * always distinct ids, and sized by the per-kingdom allowance (Kitsune gets
   * three) rather than a constant.
   */
  function randomPerks(kingdomId: string): PerkId[] {
    const pool = [...PERK_IDS];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool.slice(0, perksAllowedFor(kingdomId));
  }

  function freeBotName(match: ReturnType<MatchManager["getMatch"]>): string {
    const used = new Set(match?.getPlayers().map((p) => p.name) ?? []);
    return BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${Date.now() % 1000}`;
  }

  socket.on("lobby:addBot", (payload: { difficulty?: unknown }, ack: unknown) => {
    const roomCode = typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    const playerId = typeof socket.data.playerId === "string" ? socket.data.playerId : null;
    if (!roomCode || !playerId) return respond(ack, fail("INVALID_PHASE", "Not in a room"));

    const match = matches.getMatch(roomCode);
    if (!match) return respond(ack, fail("ROOM_NOT_FOUND", "No match found"));
    if (!match.isHost(playerId)) return respond(ack, fail("NOT_HOST", "Only the host can add bots"));
    if (match.phase !== "lobby") return respond(ack, fail("INVALID_PHASE", "Match already started"));
    if (match.isFull()) return respond(ack, fail("ROOM_FULL", "The lobby is full"));
    if (match.activePlayerCount >= MATCH.MAX_ACTIVE_PLAYERS) {
      return respond(ack, fail("ROOM_FULL", "All playing seats are taken"));
    }

    const kingdomId = freeKingdom(match);
    if (kingdomId === null) return respond(ack, fail("ROOM_FULL", "No kingdoms left"));

    // Hard by default: it is the strongest trained model and the one the game
    // should show off. A host who wants an easier game says so explicitly.
    const difficulty: BotDifficulty = isBotDifficulty(payload?.difficulty)
      ? payload.difficulty
      : "hard";

    // Unique by construction and namespaced, so a bot id can never collide with
    // a session-derived human id.
    const id = `bot-${roomCode}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const bot: MatchPlayer = {
      id,
      socketId: null,
      name: freeBotName(match),
      kingdomId: kingdomId as MatchPlayer["kingdomId"],
      perks: randomPerks(kingdomId),
      ready: true,
      connected: true,
      isBot: true,
      botDifficulty: difficulty,
    };
    try {
      match.addPlayer(bot);
    } catch (error) {
      return respond(ack, fail("ROOM_FULL", (error as Error).message));
    }

    logger.info("Bot added", { roomCode, botId: id, difficulty });
    broadcastLobbyUpdate(io, match);
    respond(ack, ok({ botId: id, difficulty }));
  });

  socket.on("lobby:setBotDifficulty", (payload: { botId?: unknown; difficulty?: unknown }, ack: unknown) => {
    const roomCode = typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    const playerId = typeof socket.data.playerId === "string" ? socket.data.playerId : null;
    if (!roomCode || !playerId) return respond(ack, fail("INVALID_PHASE", "Not in a room"));

    const match = matches.getMatch(roomCode);
    if (!match) return respond(ack, fail("ROOM_NOT_FOUND", "No match found"));
    if (!match.isHost(playerId)) return respond(ack, fail("NOT_HOST", "Only the host can change bots"));
    if (match.phase !== "lobby") return respond(ack, fail("INVALID_PHASE", "Match already started"));
    if (!isBotDifficulty(payload?.difficulty)) {
      return respond(ack, fail("INVALID_PAYLOAD", "difficulty must be easy, medium or hard"));
    }

    const bot = match.getPlayers().find((p) => p.id === payload.botId && p.isBot);
    if (!bot) return respond(ack, fail("PLAYER_NOT_FOUND", "No such bot"));

    bot.botDifficulty = payload.difficulty;
    broadcastLobbyUpdate(io, match);
    respond(ack, ok({ botId: bot.id, difficulty: bot.botDifficulty }));
  });

  socket.on("lobby:removeBot", (payload: { botId?: unknown }, ack: unknown) => {
    const roomCode = typeof socket.data.roomCode === "string" ? socket.data.roomCode : null;
    const playerId = typeof socket.data.playerId === "string" ? socket.data.playerId : null;
    if (!roomCode || !playerId) return respond(ack, fail("INVALID_PHASE", "Not in a room"));

    const match = matches.getMatch(roomCode);
    if (!match) return respond(ack, fail("ROOM_NOT_FOUND", "No match found"));
    if (!match.isHost(playerId)) return respond(ack, fail("NOT_HOST", "Only the host can remove bots"));
    if (match.phase !== "lobby") return respond(ack, fail("INVALID_PHASE", "Match already started"));

    const bot = match.getPlayers().find((p) => p.id === payload?.botId && p.isBot);
    if (!bot) return respond(ack, fail("PLAYER_NOT_FOUND", "No such bot"));

    match.removePlayer(bot.id);
    logger.info("Bot removed", { roomCode, botId: bot.id });
    broadcastLobbyUpdate(io, match);
    respond(ack, ok({ botId: bot.id }));
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
