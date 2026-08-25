import type { Match } from "../match/Match.js";
import type { MatchPlayer } from "../match/types.js";
import { MATCH } from "../data/balance.js";
import type { Server } from "socket.io";
import type { GameLoopManager } from "../engine/GameLoopManager.js";
import { createMatchConfig } from "../match/matchConfig.js";
import { broadcastLobbyUpdate } from "./lobbyRoom.js";
import { logger } from "../util/logger.js";
import { freeKingdom, randomPerks, pickBotName } from "./lobbyHandlers.js";

/**
 * Getting a matchmade room ready to start.
 *
 * ⚠️ A PUBLIC LOBBY CANNOT WAIT FOR EVERYONE TO BE READY. `Match.canStart()`
 * requires every connected player to be ready with a kingdom AND a full perk
 * selection, which is the right rule for a room of friends whose host waits for
 * them. A stranger who joins a public room and then walks away is never going
 * to satisfy it, and the countdown fires regardless — so the room has to be
 * made startable rather than asked whether it is.
 *
 * Nobody is dropped for being slow. A player who clicked "join public" wants to
 * play, so an unfinished lobby screen is filled in for them rather than being
 * treated as an absence.
 */

/** What `seatEveryone` had to decide on the players' behalf. */
export interface SeatingResult {
  /** Players who never picked a kingdom and were given one. */
  assignedKingdom: string[];
  /** Players who never finished a perk selection and were given one. */
  assignedPerks: string[];
  /** Bots added to fill the remaining seats. */
  botsAdded: number;
}

/**
 * Makes every seat legal, then fills what is left with bots.
 *
 * Order matters: humans are seated FIRST so they get their pick of the free
 * kingdoms, and bots take whatever is left over. Seating bots first would let a
 * bot take a kingdom out from under a player who was still choosing.
 */
export function seatEveryone(match: Match): SeatingResult {
  const result: SeatingResult = { assignedKingdom: [], assignedPerks: [], botsAdded: 0 };

  for (const player of match.getPlayers()) {
    if (player.spectator || player.socketId === null) continue;

    if (player.kingdomId === null) {
      const kingdom = freeKingdom(match);
      // No kingdoms left is not a crash: the seat simply stays unready and the
      // start guard below will not count it.
      if (kingdom === null) continue;
      player.kingdomId = kingdom as MatchPlayer["kingdomId"];
      result.assignedKingdom.push(player.id);
    }

    // Re-rolled whenever the selection is not COMPLETE, not merely absent — a
    // half-finished pick fails `hasFullPerkSelection` exactly as an empty one
    // does, and would leave the room unable to start.
    // `kingdomId` is non-null by here: either it already was, or it was just
    // assigned above and a failure to assign `continue`d past this point.
    const allowed = randomPerks(player.kingdomId as string);
    if (!player.perks || player.perks.length !== allowed.length) {
      player.perks = allowed;
      result.assignedPerks.push(player.id);
    }

    player.ready = true;
  }

  while (
    match.activePlayerCount < MATCH.MAX_ACTIVE_PLAYERS &&
    !match.isFull()
  ) {
    const kingdomId = freeKingdom(match);
    if (kingdomId === null) break;
    const bot: MatchPlayer = {
      id: `bot-${match.roomCode}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      socketId: null,
      name: pickBotName(match.getPlayers().map((p) => p.name)),
      kingdomId: kingdomId as MatchPlayer["kingdomId"],
      perks: randomPerks(kingdomId),
      ready: true,
      connected: true,
      // Public rooms fill with HARD bots deliberately: a matchmade game is the
      // one place a player cannot ask for an easier opponent, and a lobby that
      // quietly padded itself with easy bots would be a worse game than the one
      // they queued for.
      isBot: true,
      botDifficulty: "hard",
    };
    match.addPlayer(bot);
    result.botsAdded += 1;
  }

  return result;
}


/**
 * Starts a matchmade room: seat the stragglers, fill with bots, go.
 *
 * Module scope rather than inside a socket handler because BOTH triggers live
 * outside any one socket — the countdown firing on a timer, and the seat cap
 * filling. Two launch paths would be two places for the room to be started
 * slightly differently.
 */
export function launchPublicMatch(
  io: Server,
  gameLoops: GameLoopManager,
  match: Match,
): void {
  if (match.phase !== "lobby") return;
  const seated = seatEveryone(match);

  if (!match.canStart()) {
    // The room emptied while the clock ran, or had no legal seat to give.
    // Nothing to launch, and nothing to log as an error either.
    logger.info("Public room had nothing to start", {
      roomCode: match.roomCode,
      active: match.activePlayerCount,
    });
    return;
  }

  match.startsAt = null;
  const config = createMatchConfig(match);
  match.start(config);
  logger.info("Public match started", {
    roomCode: match.roomCode,
    playerCount: match.playerCount,
    assignedKingdom: seated.assignedKingdom.length,
    assignedPerks: seated.assignedPerks.length,
    botsAdded: seated.botsAdded,
  });

  broadcastLobbyUpdate(io, match);
  io.to(match.roomCode).emit("match:started", {
    roomCode: match.roomCode,
    config,
    players: match.getPlayers(),
    tick: match.tick,
    serverTime: Date.now(),
  });
  gameLoops.start(match);
}