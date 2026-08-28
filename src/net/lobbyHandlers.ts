import type { Server, Socket } from "socket.io";
import type { GameLoopManager } from "../engine/GameLoopManager.js";
import type { MatchManager } from "../match/MatchManager.js";
import type { BotDifficulty, MatchPlayer } from "../match/types.js";
import type { ReconnectionManager } from "./ReconnectionManager.js";
import { fail, ok, respond } from "./ack.js";
import { broadcastLobbyUpdate, removePlayerFromMatch } from "./lobbyRoom.js";
import { ensureSessionId } from "./sessionHandlers.js";
import { buildMatchSnapshot, stampCastlePaint } from "../match/snapshot.js";
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
import { SEARCH_SECONDS, type PublicLobbyManager } from "./PublicLobbyManager.js";
import { seatEveryone } from "./publicLobby.js";

/**
 * Names for AI seats, drawn from at random.
 *
 * ⚠️ THIS LIST WAS BEING READ AS AN ORDER. `freeBotName` used
 * `BOT_NAMES.find(n => !used.has(n))`, which takes the FIRST free name, so
 * every lobby filled with bots got Ember, Cinder, Frost, Gale in that sequence,
 * every single match. Twenty-seven names read as four.
 */
export const BOT_NAMES = [
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

/**
 * A bot name no one in the room is using yet, chosen at random from what is free.
 *
 * Filtered to unused names BEFORE rolling, rather than rolling until something
 * free turns up: a nearly-full room would reroll many times for the last seat,
 * and once every name is taken it would never terminate at all.
 *
 * `roll` is injectable so a test can assert on the pick rather than around it.
 */
export function pickBotName(
  taken: readonly string[],
  roll: () => number = Math.random,
): string {
  const used = new Set(taken);
  const free = BOT_NAMES.filter((n) => !used.has(n));
  if (free.length === 0) return `Bot ${Date.now() % 1000}`;
  return free[Math.floor(roll() * free.length)]!;
}

/**
 * A kingdom nobody in the room has taken, at random, or null when all sixteen
 * are spoken for.
 *
 * Exported because a bot being added and a public lobby seating a player who
 * never chose need the same answer, and two implementations of "which kingdoms
 * are free" would drift apart.
 */
/**
 * A random kingdom nobody in the lobby has taken, or null when all are gone.
 *
 * Random rather than first-free: taking them in roster order meant the first
 * bot was always Water, the second always Fire, and a host adding three bots
 * got the same three kingdoms every single game. Chosen from the free ones
 * only, so it can never collide with a human's pick or another bot's.
 */
export function freeKingdom(match: ReturnType<MatchManager["getMatch"]>): string | null {
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
export function randomPerks(kingdomId: string): PerkId[] {
  const pool = [...PERK_IDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, perksAllowedFor(kingdomId));
}

export interface LobbyDeps {
  matches: MatchManager;
  reconnection: ReconnectionManager;
  gameLoops: GameLoopManager;
  /** Owns the countdown, the empty-room reaper and matchmaking. */
  publicLobbies: PublicLobbyManager;
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
 * The name this socket plays under.
 *
 * ⚠️ A SIGNED-IN PLAYER'S USERNAME WINS, AND THE CLIENT CANNOT OVERRIDE IT.
 * The username is their identity — it is unique, it is what a profile and a
 * win record hang off, and letting a payload field replace it would make
 * impersonating another player a matter of typing their name.
 *
 * `socket.data.username` is resolved from the account at handshake time (see
 * index.ts), so this stays synchronous and the lobby never waits on a database.
 * Guests, and the vanishingly brief window before that read lands, fall back to
 * the name the client typed.
 */
function resolvePlayerName(socket: Socket, raw: unknown): string | null {
  const username = socket.data.username as string | undefined;
  if (typeof username === "string" && username.length > 0) return username;
  return normalizeName(raw);
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
  const { matches, reconnection, gameLoops, publicLobbies } = deps;

  // Host a new match: generate a unique room code and seat the caller as host.
  /**
   * Matchmaking: seat this socket in a public room, opening one if none turns up.
   *
   * ⚠️ THE WAIT IS FOR OTHER PEOPLE, NOT FOR A ROOM. Creating a room the instant
   * nobody else has one would scatter arrivals one-per-lobby, and each would
   * then sit through its own full countdown alone. Searching first means two
   * players who queue within the window land in the SAME room. After
   * SEARCH_SECONDS with nothing to join, this socket opens the room the next
   * searcher will find.
   *
   * Node runs one request at a time, so "look, then create" cannot interleave
   * with another searcher doing the same — no lock is needed here. That stops
   * being true the day this runs as more than one process.
   */
  socket.on("lobby:joinPublic", (payload: { name?: unknown }, ack: unknown) => {
    const name = resolvePlayerName(socket, payload?.name);
    if (name === null) {
      respond(ack, fail("INVALID_PAYLOAD", "A valid player name is required"));
      return;
    }
    if (typeof socket.data.roomCode === "string") {
      respond(ack, fail("ALREADY_IN_ROOM", "Already in a room"));
      return;
    }

    const sessionId = ensureSessionId(socket);
    const startedSearchAt = Date.now();

    const seat = (match: ReturnType<MatchManager["getMatch"]>): boolean => {
      if (!match) return false;
      // Re-checked at the moment of seating, not when the room was picked: the
      // search runs over several seconds and a room can fill or start inside it.
      if (match.phase !== "lobby" || match.isFull()) return false;
      if (match.activePlayerCount >= MATCH.MAX_ACTIVE_PLAYERS) return false;
      if (match.hasPlayer(sessionId)) return false;

      const player: MatchPlayer = {
        id: sessionId,
        socketId: socket.id,
        name,
        accountId: (socket.data.accountId as string | null) ?? null,
        level: (socket.data.level as number | undefined) ?? undefined,
        loadout: (socket.data.loadout as MatchPlayer["loadout"]) ?? undefined,
        kingdomId: null,
        perks: [],
        ready: false,
        connected: true,
      };
      match.addPlayer(player);
      socket.data.playerId = player.id;
      socket.data.roomCode = match.roomCode;
      void socket.join(match.roomCode);

      socket.to(match.roomCode).emit("lobby:playerJoined", { player });
      broadcastLobbyUpdate(io, match);
      publicLobbies.onRosterChanged(match);
      publicLobbies.onHumanJoined(match);

      respond(ack, ok({ match: buildMatchSnapshot(match, player.id), playerId: player.id }));
      return true;
    };

    const existing = publicLobbies.findOpenRoom();
    if (existing && seat(existing)) return;

    // Nothing open. Poll while other searchers arrive or a room opens up, then
    // open one ourselves. Polling rather than an event bus because the set of
    // rooms changes from several handlers and a missed subscription would
    // strand a player on the search screen indefinitely.
    const poll = setInterval(() => {
      if (socket.disconnected || typeof socket.data.roomCode === "string") {
        clearInterval(poll);
        return;
      }
      const found = publicLobbies.findOpenRoom();
      if (found && seat(found)) {
        clearInterval(poll);
        return;
      }
      if (Date.now() - startedSearchAt >= SEARCH_SECONDS * 1000) {
        clearInterval(poll);
        const fresh = matches.createMatch({ visibility: "public" });
        // A public room has NO host: `hostId` stays null, which makes every
        // host-gated handler refuse for everyone rather than needing each one
        // to learn about visibility.
        if (!seat(fresh)) {
          matches.removeMatch(fresh.roomCode);
          respond(ack, fail("ROOM_NOT_FOUND", "Could not open a public room"));
        }
      }
    }, 500);
    (poll as { unref?: () => void }).unref?.();
  });

  socket.on("lobby:create", (payload: { name?: unknown }, ack: unknown) => {
    const name = resolvePlayerName(socket, payload?.name);
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
      accountId: (socket.data.accountId as string | null) ?? null,
        level: (socket.data.level as number | undefined) ?? undefined,
        loadout: (socket.data.loadout as MatchPlayer["loadout"]) ?? undefined,
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
      const name = resolvePlayerName(socket, payload?.name);
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
        accountId: (socket.data.accountId as string | null) ?? null,
        level: (socket.data.level as number | undefined) ?? undefined,
        loadout: (socket.data.loadout as MatchPlayer["loadout"]) ?? undefined,
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
    // ⚠️ NEVER IN A PUBLIC ROOM. Seeing every surviving kingdom's health after
    // dying is a real advantage handed to someone who can no longer be punished
    // for having it, and among friends it is also a coaching channel. Both are
    // choices a room of people who know each other can make; neither is
    // something a stranger should be able to switch on for you. Refused here as
    // well as hidden in the lobby UI — a client is not a permission check.
    if (match.visibility === "public") {
      respond(ack, fail("NOT_ALLOWED", "That rule is fixed in public matches"));
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
    // Skins are resolved here, once, and ride along on the seats from now on.
    stampCastlePaint(match);
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



  function isBotDifficulty(value: unknown): value is BotDifficulty {
    return value === "easy" || value === "medium" || value === "hard";
  }



  function freeBotName(match: ReturnType<MatchManager["getMatch"]>): string {
    return pickBotName(match?.getPlayers().map((p) => p.name) ?? []);
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
    removePlayerFromMatch(io, matches, roomCode, playerId, "left", (m) =>
      publicLobbies.onRosterChanged(m),
    );

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
