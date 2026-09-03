import { PARTY, TICK } from "../../data/balance.js";
import { param } from "../parameters.js";
import { standingCentrepiece } from "../centrepiece.js";
import { earn } from "../money.js";
import type { Match } from "../../match/Match.js";
import type { PlayerState } from "../../match/playerState.js";
import { MAZE_GAME } from "./maze.js";
import { MEMORY_GAME } from "./memory.js";
import { LOCKPICK_GAME, settleLockpick } from "./lockpick.js";
import { BLACKJACK_GAME } from "./partyBlackjack.js";
import { SPOT_THE_DIFFERENCE_GAME } from "./spotTheDifference.js";
import { REACTION_GAME, settleReaction } from "./reaction.js";
import { QUICK_MATH_GAME, settleQuickMath } from "./quickMath.js";
import { BUTTON_MASH_GAME, settleButtonMash } from "./buttonMash.js";
import { BOMB_ATTACK_GAME, settleBombAttack, bombIsLive } from "./bombAttack.js";
import { KINGDOM_THIEF_GAME, settleKingdomThief } from "./kingdomThief.js";
import { PICK_A_CHEST_GAME } from "./pickAChest.js";
import { DONT_MOVE_GAME } from "./dontMove.js";
import { KINGDOM_SWAP_GAME, tickKingdomSwaps } from "./kingdomSwap.js";
import { HAUNTED_GAME, hasGhostsToRaise, tickGhosts } from "./haunted.js";
import { GOLD_PARTY_GAME } from "./goldParty.js";
import { CLEAN_UP_GAME } from "./cleanUp.js";
import type {
  PartyAction,
  PartyActionResult,
  PartyGame,
  PartyGameId,
  PartySession,
} from "./types.js";

export * from "./types.js";
export { generateMaze, routeIsLegal } from "./maze.js";
export { buildSequence, buildQuestion, MEMORY_SYMBOLS } from "./memory.js";
export { angleInZone, nextLock } from "./lockpick.js";
export { handValue, openHand, resolveRound, settleMoney } from "./partyBlackjack.js";
export { eligibleCastles } from "./spotTheDifference.js";
export { buildQuestion as buildMathQuestion } from "./quickMath.js";
export { longestHolder, bombIsLive } from "./bombAttack.js";
export { kingdomLabel, rankedFirst, rankedLast } from "./results.js";
export { shuffleChests } from "./pickAChest.js";
export { isGhost, isGhostAt, hauntable, hasGhostsToRaise } from "./haunted.js";
export { kitKingdomOf, mirrorSlot, canUseAbility } from "./kingdomSwap.js";
export { buildShower } from "./goldParty.js";
export { buildMess } from "./cleanUp.js";

/**
 * Party Mode.
 *
 * Every so often the field stops being a war and becomes a party: a minigame
 * drops in front of every living kingdom at once, pays out, and gets out of the
 * way. This module owns the clock that decides when, the session that holds one
 * while it runs, and the rules every game shares.
 *
 * ⚠️ THE ROLL FREEZES WHILE THE CENTRE IS OCCUPIED, AND IS NOT SKIPPED. Same
 * rule as the monster's spawn clock and for the same reason: a checked-and-
 * skipped roll would quietly eat the table's twenty-five seconds, so a match
 * full of ultimates would see fewer minigames than a quiet one — backwards.
 *
 * ⚠️ A MINIGAME DOES NOT HOLD THE CENTRE ITSELF. A monster may arrive in the
 * middle of one. What a running minigame DOES do is stop attacks until somebody
 * finishes it, because a table looking at a maze cannot defend itself and being
 * shot at for playing along is not a party.
 */

export const PARTY_GAMES: readonly PartyGame[] = [
  MAZE_GAME,
  SPOT_THE_DIFFERENCE_GAME,
  BLACKJACK_GAME,
  MEMORY_GAME,
  LOCKPICK_GAME,
  REACTION_GAME,
  QUICK_MATH_GAME,
  BUTTON_MASH_GAME,
  BOMB_ATTACK_GAME,
  KINGDOM_THIEF_GAME,
  PICK_A_CHEST_GAME,
  DONT_MOVE_GAME,
  KINGDOM_SWAP_GAME,
  HAUNTED_GAME,
  GOLD_PARTY_GAME,
  CLEAN_UP_GAME,
];

export function partyGame(id: PartyGameId): PartyGame | undefined {
  return PARTY_GAMES.find((g) => g.id === id);
}

/** Whether this seat is driven by a bot rather than a person. */
function isBotSeat(match: Match, playerId: string): boolean {
  return match.getPlayers().find((p) => p.id === playerId)?.isBot === true;
}

/** Living kingdoms — the only ones a minigame is ever dealt to. */
function contenders(match: Match): PlayerState[] {
  return match.gameState?.getPlayers().filter((p) => !p.eliminated) ?? [];
}

/**
 * Advances the party clock and rolls when it comes due.
 *
 * The chance is `living kingdoms / 10`, exactly as the monster's is: a duel
 * sees one now and then, a seven-player table sees them constantly, which is
 * the right shape — the bigger the table, the more a shared interruption is
 * worth.
 */
export function tickPartyClock(match: Match): void {
  const state = match.gameState;
  if (!state) return;
  if (!match.partyModeEnabled) return;
  // One at a time. A session that is finished but still showing its result
  // banner also holds the clock, so the next game never lands on the last one's
  // announcement.
  if (state.party !== null) return;

  if (state.partyClock === null) {
    state.partyClock = {
      ticksUntilRoll: Math.round(
        param("party.firstRollSeconds", PARTY.FIRST_ROLL_SECONDS) * TICK.RATE,
      ),
    };
  }
  const clock = state.partyClock;

  // Anything in the middle of the field holds the clock — the roll waits for it
  // to leave rather than being spent while it stands.
  if (standingCentrepiece(match) !== null) return;

  clock.ticksUntilRoll -= 1;
  if (clock.ticksUntilRoll > 0) return;
  clock.ticksUntilRoll = Math.round(
    param("party.rollIntervalSeconds", PARTY.ROLL_INTERVAL_SECONDS) * TICK.RATE,
  );

  const living = contenders(match).length;
  if (living < 2) return; // a party of one is not a party
  const divisor = Math.max(1, param("party.chanceDivisor", PARTY.CHANCE_DIVISOR));
  if (match.rng() >= living / divisor) return;

  // Only from the games that CAN run: Haunted with nobody dead is a banner
  // announcing nothing, and it would still hold the next roll for its whole
  // duration.
  const playable = PARTY_GAMES.filter((g) => g.canStart?.(match) !== false);
  if (playable.length === 0) return;
  const game = playable[Math.floor(match.rng() * playable.length)]!;
  startParty(match, game.id);
}

/**
 * Puts a minigame in front of the table.
 *
 * Exported so the debug launcher can call it directly — see
 * `net/partyHandlers.ts`, which is host-and-localhost only.
 */
export function startParty(match: Match, gameId: PartyGameId): PartySession | null {
  const state = match.gameState;
  if (!state || state.party !== null) return null;
  const game = partyGame(gameId);
  if (!game) return null;
  if (game.canStart?.(match) === false) return null;

  const players = contenders(match);
  if (players.length === 0) return null;

  const setup = game.setup(match, players);
  const session: PartySession = {
    gameId,
    startedTick: match.tick,
    endsTick:
      game.timedSeconds === null
        ? null
        : match.tick + Math.round(game.timedSeconds * TICK.RATE),
    expiresTick: match.tick + Math.round(game.maxSeconds * TICK.RATE),
    shared: setup.shared,
    players: {},
    firstFinisherId: null,
    firstFinishTick: null,
    finishOrder: [],
    resolvedTick: null,
    resultText: null,
  };
  for (const player of players) {
    session.players[player.id] = {
      done: false,
      outcome: null,
      finishedTick: null,
      data: setup.perPlayer[player.id] ?? {},
    };
  }
  state.party = session;
  state.events.emit({
    type: "partyStarted",
    tick: match.tick,
    gameId,
    description: game.description,
  });
  return session;
}

/**
 * True while nothing may claim the middle of the field.
 *
 * From the moment a minigame starts until `CENTREPIECE_GRACE_SECONDS` after the
 * FIRST kingdom finishes it. Attacks resume the instant somebody finishes —
 * that is a fight, and the table can defend itself — but a centrepiece is a
 * different thing entirely: a volcano or a monster landing on that same beat
 * greets the players still in the maze with an ultimate they never saw cast.
 */
export function partyBlocksCentrepieces(match: Match): boolean {
  const session = match.gameState?.party;
  if (!session || session.resolvedTick !== null) return false;
  // Weather does not hold the middle of the field either: a thirty-second swap
  // that also banned every ultimate would be a far bigger event than the swap.
  if (partyGame(session.gameId)?.holdsAttacks === false) return false;
  if (session.firstFinishTick === null) return true;
  const grace = Math.round(
    param("party.centrepieceGrace", PARTY.CENTREPIECE_GRACE_SECONDS) * TICK.RATE,
  );
  return match.tick < session.firstFinishTick + grace;
}

/**
 * True while the table may not choose targets at all.
 *
 * Bomb Attack only: clicking a castle passes the bomb, and a click that both
 * passed the bomb and re-aimed a kingdom would be unusable.
 */
export function partyBlocksTargeting(match: Match): boolean {
  return bombIsLive(match);
}

/**
 * Whether a running minigame is currently holding attacks.
 *
 * True from the moment one starts until the first kingdom finishes it. After
 * that the table is back in the fight even if some of them are still playing —
 * the alternative is that one slow player freezes the war for everybody.
 */
export function partySuppressesAttacks(match: Match): boolean {
  const session = match.gameState?.party;
  if (!session) return false;
  if (session.resolvedTick !== null) return false;
  // An ambient game never pauses the war — see `holdsAttacks`. Nobody finishes
  // weather, so the hold would run for its whole duration.
  if (partyGame(session.gameId)?.holdsAttacks === false) return false;
  return session.firstFinisherId === null;
}

/** Runs the active session: per-player ticks, bots, and the clock that ends it. */
export function tickParty(match: Match): void {
  const state = match.gameState;
  if (!state) return;

  // ⚠️ BEFORE THE SESSION CHECK, AND OUTSIDE IT. A ghost's welcome and a
  // borrowed kit both outlive the session that granted them — the session is
  // cleared four seconds after it resolves, and Haunted runs for twenty-five.
  // Expiring them here means they end on their own clock however the session
  // ends, rather than leaving a dead player attacking, or somebody holding
  // another kingdom's abilities, for the rest of the match.
  tickGhosts(match);
  tickKingdomSwaps(match);

  const session = state.party;
  if (!session) return;

  const game = partyGame(session.gameId);
  if (!game) {
    state.party = null;
    return;
  }

  // The result banner lingers, then the session is cleared and the clock starts
  // again.
  if (session.resolvedTick !== null) {
    const linger = Math.round(
      param("party.resultSeconds", PARTY.RESULT_SECONDS) * TICK.RATE,
    );
    if (match.tick >= session.resolvedTick + linger) state.party = null;
    return;
  }

  // Once per tick, before the per-player pass.
  game.tickSession?.(match, session);

  for (const player of state.getPlayers()) {
    const me = session.players[player.id];
    if (!me) continue;
    // Eliminated mid-game: they are out of the match, so they are out of the
    // party. Marked done rather than deleted so the finish order stays stable.
    if (player.eliminated && !me.done) {
      me.done = true;
      me.outcome = "lost";
      me.finishedTick = match.tick;
      continue;
    }
    if (me.done) continue;
    // `isBot` is a property of the SEAT, not the castle: a PlayerState is the
    // kingdom on the field and knows nothing about who is driving it.
    if (isBotSeat(match, player.id)) game.bot(match, session, player);
    else game.tick?.(match, session, player);
  }

  // Recompute the finish order from scratch each tick: a player can be marked
  // done by their own action, by a bot roll, or by elimination, and one place
  // that reads the result is easier to keep honest than three that write it.
  syncFinishOrder(match, session);

  const everyoneDone = Object.values(session.players).every((p) => p.done);
  const timedOut = session.endsTick !== null && match.tick >= session.endsTick;
  const expired = match.tick >= session.expiresTick;
  if (everyoneDone || timedOut || expired) {
    resolveParty(match);
  }
}

/** Keeps `finishOrder` and `firstFinisherId` in step with who is done. */
function syncFinishOrder(match: Match, session: PartySession): void {
  const finished = Object.entries(session.players)
    .filter(([, p]) => p.done && p.finishedTick !== null)
    .sort((a, b) => (a[1].finishedTick ?? 0) - (b[1].finishedTick ?? 0))
    .map(([id]) => id);
  session.finishOrder = finished;
  if (session.firstFinisherId === null && finished.length > 0) {
    session.firstFinisherId = finished[0]!;
    session.firstFinishTick = match.tick;
    match.gameState?.events.emit({
      type: "partyFirstFinish",
      tick: match.tick,
      gameId: session.gameId,
      playerId: finished[0]!,
    });
  }
}

/** Closes the session: settles anything owed, writes the result banner. */
export function resolveParty(match: Match): void {
  const state = match.gameState;
  const session = state?.party;
  if (!state || !session || session.resolvedTick !== null) return;
  const game = partyGame(session.gameId);
  if (!game) {
    state.party = null;
    return;
  }

  // Anybody still playing when the clock runs out is finished where they stand
  // — unless the game has something specific to say about it, which is what
  // `forceFinish` is for. Asking the game rather than special-casing ids here
  // is what stopped this loop from quietly pre-empting the settlements: it used
  // to mark every straggler "done", after which a game looking for players who
  // had not acted found none.
  for (const player of state.getPlayers()) {
    const me = session.players[player.id];
    if (!me || me.done) continue;
    if (game.forceFinish) {
      game.forceFinish(match, session, player);
      continue;
    }
    me.done = true;
    me.outcome = "lost";
    me.finishedTick = match.tick;
  }
  syncFinishOrder(match, session);

  // Rewards and punishments that depend on the WHOLE TABLE rather than on one
  // player's own result — who was last, who clicked most, who held the bomb
  // longest. None of these can be settled while people are still playing.
  if (session.gameId === "reaction") settleReaction(match, session);
  if (session.gameId === "quickMath") settleQuickMath(match, session);
  if (session.gameId === "buttonMash") settleButtonMash(match, session);
  if (session.gameId === "bombAttack") settleBombAttack(match, session);
  // The barrier game that pays as a TABLE: every choice is in by now (the
  // stragglers were defaulted above), so the payout can finally be worked out.
  if (session.gameId === "kingdomThief") settleKingdomThief(match, session);
  if (session.gameId === "lockpick") {
    settleLockpick(
      session,
      (id) => state.getPlayer(id),
      (id, amount) => {
        const player = state.getPlayer(id);
        if (player) earn(player, amount);
      },
    );
  }

  session.resolvedTick = match.tick;
  session.resultText = game.result(match, session);
  state.events.emit({
    type: "partyEnded",
    tick: match.tick,
    gameId: session.gameId,
    resultText: session.resultText,
    finishOrder: [...session.finishOrder],
  });
}

/** Applies one player's move. The only way a client touches a minigame. */
export function actOnParty(
  match: Match,
  player: PlayerState,
  action: PartyAction,
): PartyActionResult {
  const session = match.gameState?.party;
  if (!session) return { ok: false, error: "No minigame is running" };
  if (session.resolvedTick !== null) return { ok: false, error: "It is over" };
  const game = partyGame(session.gameId);
  if (!game) return { ok: false, error: "Unknown minigame" };
  if (player.eliminated) return { ok: false, error: "You are out" };

  const result = game.act(match, session, player, action);
  if (result.ok) syncFinishOrder(match, session);
  return result;
}

/**
 * True while this player owes the minigame an answer and earns nothing.
 *
 * Takes the GAME STATE rather than the match: it is read from
 * `applyPassiveIncome`, which is handed the state and has no route back to the
 * match. Passing one down just for this would put a back-reference on every
 * game state to serve one boolean.
 */
export function partyStopsProduction(
  state: { party: PartySession | null },
  player: PlayerState,
): boolean {
  const session = state.party;
  if (!session || session.resolvedTick !== null) return false;
  const game = partyGame(session.gameId);
  if (!game || !game.stopsProduction) return false;
  const me = session.players[player.id];
  return me !== undefined && !me.done;
}
