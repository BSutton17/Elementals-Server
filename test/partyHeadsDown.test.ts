import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { earn } from "../src/engine/money.js";
import {
  startParty,
  partyBlocksVictimPrompts,
  partyOccupiesBot,
} from "../src/engine/party/index.js";
import {
  activateAbility,
  victimPromptOpenedBy,
  type AbilityDefinition,
} from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { ROULETTE, SLOT_MACHINE, BLACKJACK } from "../src/data/jokerAbilities.js";
import type { MatchPlayer } from "../src/match/types.js";

/**
 * Heads-down minigames, and the two things that used to walk straight through
 * them.
 *
 * ⚠️ THE ATTACK HOLD IS NOT THE SAME RULE AS THIS ONE, and the gap between them
 * is exactly where the bug lived. Attacks come back the moment the FIRST player
 * finishes — the table can defend itself again. But Roulette and Slot Machine
 * do not merely hurt somebody: they freeze the victim's income until the victim
 * answers a prompt. Cast at a player who is still in the maze, that is a bill
 * they cannot pay for reasons they cannot see, handed to them by the one person
 * who got out first.
 */

const seat = (id: string, kingdomId: string, isBot = false): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
  ...(isBot ? { isBot: true, botDifficulty: "medium" as const } : {}),
});

function table(): Match {
  let state = 12345;
  const rng = () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
  const match = new Match("MAZE", { rng });
  match.addPlayer(seat("joker", "joker"));
  match.addPlayer(seat("victim", "water"));
  match.addPlayer(seat("third", "earth"));
  match.hostId = "joker";
  match.start(createMatchConfig(match));
  for (const p of match.gameState!.getPlayers()) earn(p, 50_000);
  return match;
}

/** Unlock an ability so the only thing that can refuse the cast is the rule. */
function unlock(match: Match, id: string, abilityId: string) {
  const player = match.gameState!.getPlayer(id)!;
  assert.equal(
    unlockOrUpgradeAbility(match, player, abilityId).ok,
    true,
    `could not unlock ${abilityId}`,
  );
  player.target = "victim";
  return player;
}

/** ⚠️ Takes the DEFINITION, not the id — `activateAbility` resolves the object. */
const cast = (match: Match, ability: AbilityDefinition) =>
  activateAbility(match, match.gameState!.getPlayer("joker")!, ability, {
    targetId: "victim",
    forceCrit: false,
    rng: () => 0.5,
  });

test("the two prompts are recognised from their effects, not a list of ids", () => {
  assert.equal(victimPromptOpenedBy(ROULETTE), "roulette");
  assert.equal(victimPromptOpenedBy(SLOT_MACHINE), "slotMachine");
  // Blackjack resolves on the spot and asks the victim nothing, so it is not
  // one of these and must not be swept up by the rule.
  assert.equal(victimPromptOpenedBy(BLACKJACK), null);
});

test("Roulette is refused while the table is in the maze", () => {
  const match = table();
  unlock(match, "joker", ROULETTE.id);
  startParty(match, "maze");

  const result = cast(match, ROULETTE);
  assert.equal(result.ok, false);
  assert.equal(result.error, "PARTY_IN_PROGRESS");
});

test("...and so is Slot Machine", () => {
  const match = table();
  unlock(match, "joker", SLOT_MACHINE.id);
  startParty(match, "maze");

  const result = cast(match, SLOT_MACHINE);
  assert.equal(result.ok, false);
  assert.equal(result.error, "PARTY_IN_PROGRESS");
});

test("⚠️ STILL REFUSED AFTER THE FIRST PLAYER ESCAPES — the whole point", () => {
  // The attack hold lifts here. This rule does not: everyone else is still
  // looking at a maze, and they are precisely who the prompt would land on.
  const match = table();
  unlock(match, "joker", ROULETTE.id);
  const session = startParty(match, "maze")!;

  session.firstFinisherId = "joker";
  session.firstFinishTick = match.tick;
  session.players["joker"]!.done = true;

  assert.equal(partyBlocksVictimPrompts(match), true, "the hold lifted too early");
  const result = cast(match, ROULETTE);
  assert.equal(result.ok, false);
  assert.equal(result.error, "PARTY_IN_PROGRESS");
});

test("and allowed again once the session is over", () => {
  const match = table();
  unlock(match, "joker", ROULETTE.id);
  const session = startParty(match, "maze")!;
  session.resolvedTick = match.tick;

  assert.equal(partyBlocksVictimPrompts(match), false);
  const result = cast(match, ROULETTE);
  assert.equal(result.ok, true, `refused after the maze ended: ${result.error}`);
});

test("an ambient game does not block them", () => {
  // Gold Party declares `holdsAttacks: false` — nobody is heads-down, so
  // nothing stops the victim from answering a wheel.
  const match = table();
  unlock(match, "joker", ROULETTE.id);
  startParty(match, "goldParty");

  assert.equal(partyBlocksVictimPrompts(match), false);
  assert.equal(cast(match, ROULETTE).ok, true);
});

// --- bots are busy playing ---------------------------------------------------

test("a bot still in the maze is occupied, and a finished one is not", () => {
  const match = table();
  const session = startParty(match, "maze")!;

  assert.equal(partyOccupiesBot(match, "victim"), true, "a bot mid-maze was free to act");

  session.players["victim"]!.done = true;
  assert.equal(
    partyOccupiesBot(match, "victim"),
    false,
    "a bot that finished is still being held",
  );
});

test("an ambient game occupies nobody", () => {
  const match = table();
  startParty(match, "goldParty");
  assert.equal(partyOccupiesBot(match, "victim"), false);
});

test("a seat that is not playing the minigame is not occupied by it", () => {
  const match = table();
  const session = startParty(match, "maze")!;
  delete session.players["third"];
  assert.equal(partyOccupiesBot(match, "third"), false);
});

test("nothing is occupied once the session resolves", () => {
  const match = table();
  const session = startParty(match, "maze")!;
  session.resolvedTick = match.tick;
  assert.equal(partyOccupiesBot(match, "victim"), false);
});
