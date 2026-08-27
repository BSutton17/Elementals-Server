import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  contribution,
  nextResetAt,
  questById,
  questDay,
  rollDailyQuests,
  type QuestState,
} from "../src/engine/quests.js";
import { QUESTS, QUESTS_PER_DAY, QUEST_TIERS } from "../src/data/quests.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";
import type { MatchParticipantResult, MatchResult } from "../src/match/matchResult.js";

// Daily quests. Three a day, one of each difficulty, derived from (account,
// day) rather than stored — so the tests that matter are about determinism,
// the day boundary, and progress rules that are easy to get subtly wrong.

const seat = (over: Partial<MatchParticipantResult> = {}): MatchParticipantResult =>
  ({
    playerId: "me",
    name: "Me",
    kingdomId: "fire",
    accountId: "acct",
    isBot: false,
    botDifficulty: null,
    placement: 1,
    eliminatedAtTick: null,
    survivedTicks: 6000,
    hpRemaining: 8000,
    maxHp: 10000,
    stats: {
      damageDealt: 5000,
      damageTaken: 1000,
      damageShielded: 800,
      healingDone: 300,
      goldEarned: 2000,
      goldSpent: 1500,
      abilitiesCast: 40,
      killsCredited: 2,
    },
    ...over,
  }) as MatchParticipantResult;

const match = (over: Partial<MatchResult> = {}): MatchResult =>
  ({
    matchId: "m",
    playerCount: 7,
    humanCount: 7,
    tickRate: 20,
    durationTicks: 6000,
    participants: [seat(), seat({ playerId: "o", placement: 2 })],
    ...over,
  }) as MatchResult;

const fresh = (): QuestState => ({ progress: 0, seenKingdoms: [], completed: false });

// --- the daily boundary ------------------------------------------------------

test("the day flips at the reset hour, not at UTC midnight", () => {
  // 10:00 CT is 15:00 UTC. An instant just before belongs to the previous day.
  const before = new Date("2026-08-26T14:59:00Z");
  const after = new Date("2026-08-26T15:01:00Z");
  assert.notEqual(questDay(before), questDay(after));
  assert.equal(questDay(after), "2026-08-26");
});

test("everything within one quest day shares a day string", () => {
  const morning = new Date("2026-08-26T15:30:00Z");
  const evening = new Date("2026-08-27T02:00:00Z"); // still the same quest day
  assert.equal(questDay(morning), questDay(evening));
});

test("the next reset is in the future and within a day", () => {
  const now = new Date("2026-08-26T18:00:00Z");
  const next = nextResetAt(now);
  assert.ok(next.getTime() > now.getTime());
  assert.ok(next.getTime() - now.getTime() <= 86_400_000);
});

// --- rolling -----------------------------------------------------------------

test("THE SAME PLAYER GETS THE SAME THREE QUESTS ALL DAY", () => {
  // Derived, not stored: this is what lets a player who never opens the game
  // still find the same three waiting, on any device, after any restart.
  const a = rollDailyQuests("acct-1", "2026-08-26");
  const b = rollDailyQuests("acct-1", "2026-08-26");
  assert.deepEqual(a, b);
});

test("different players and different days get different sets", () => {
  const mine = rollDailyQuests("acct-1", "2026-08-26").map((q) => q.questId).join();
  const theirs = rollDailyQuests("acct-2", "2026-08-26").map((q) => q.questId).join();
  const tomorrow = rollDailyQuests("acct-1", "2026-08-27").map((q) => q.questId).join();
  assert.notEqual(mine, theirs);
  assert.notEqual(mine, tomorrow);
});

test("ALWAYS ONE OF EACH TIER, never three hard ones", () => {
  // Rolling three at random would regularly hand somebody an unreachable day.
  for (const account of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
    const rolled = rollDailyQuests(account, "2026-08-26");
    assert.equal(rolled.length, QUESTS_PER_DAY);
    assert.deepEqual(
      rolled.map((q) => q.tier),
      ["easy", "medium", "hard"],
    );
  }
});

test("harder quests pay more, in both currencies", () => {
  assert.ok(QUEST_TIERS.medium.xp > QUEST_TIERS.easy.xp);
  assert.ok(QUEST_TIERS.hard.xp > QUEST_TIERS.medium.xp);
  assert.ok(QUEST_TIERS.medium.coins > QUEST_TIERS.easy.coins);
  assert.ok(QUEST_TIERS.hard.coins > QUEST_TIERS.medium.coins);
  // And every quest pays BOTH, never one or the other.
  for (const tier of Object.values(QUEST_TIERS)) {
    assert.ok(tier.xp > 0 && tier.coins > 0);
  }
});

test("kingdom-scoped quests roll a real kingdom and name it", () => {
  let found = 0;
  for (let i = 0; i < 60; i++) {
    for (const quest of rollDailyQuests("acct-" + i, "2026-08-26")) {
      const definition = questById(quest.questId)!;
      if (!definition.kingdomScoped) continue;
      found++;
      assert.ok(KINGDOM_IDS.includes(quest.kingdomId as never));
      assert.ok(!quest.description.includes("{"), "placeholders must be filled");
      assert.ok(
        quest.description.toLowerCase().includes(quest.kingdomId!.toLowerCase()),
        "the kingdom has to appear in the text",
      );
    }
  }
  assert.ok(found > 0, "the catalogue should contain kingdom-scoped quests");
});

test("every description is fully rendered", () => {
  for (let i = 0; i < 30; i++) {
    for (const quest of rollDailyQuests("x" + i, "2026-08-26")) {
      assert.ok(!quest.description.includes("{target}"));
      assert.ok(!quest.description.includes("{kingdom}"));
    }
  }
});

test("every quest in the catalogue is reachable and well-formed", () => {
  for (const quest of QUESTS) {
    assert.ok(quest.target > 0, `${quest.id} needs a target`);
    assert.ok(QUEST_TIERS[quest.tier], `${quest.id} has an unknown tier`);
    assert.ok(quest.template.length > 0);
  }
  const ids = QUESTS.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, "quest ids must be unique");
});

// --- progress rules ----------------------------------------------------------

const roll = (questId: string, kingdomId: string | null = null) => ({
  slot: 0,
  questId,
  tier: "easy" as const,
  description: "",
  target: questById(questId)!.target,
  kingdomId,
  xp: 0,
  coins: 0,
});

test("a match below the minimum lobby size does not count", () => {
  const quest = questById("topThree")!; // minPlayers 4
  const small = match({ playerCount: 3 });
  assert.equal(contribution(quest, roll("topThree"), seat(), small), 0);
  assert.ok(contribution(quest, roll("topThree"), seat(), match()) > 0);
});

test("a quest that requires a win ignores losses", () => {
  const quest = questById("winAsKingdom1")!;
  const r = roll("winAsKingdom1", "fire");
  assert.equal(contribution(quest, r, seat({ placement: 2 }), match()), 0);
  assert.equal(contribution(quest, r, seat({ placement: 1 }), match()), 1);
});

test("a kingdom-scoped quest only counts that kingdom", () => {
  const quest = questById("winAsKingdom1")!;
  const r = roll("winAsKingdom1", "fire");
  assert.equal(contribution(quest, r, seat({ kingdomId: "water" }), match()), 0);
  assert.equal(contribution(quest, r, seat({ kingdomId: "fire" }), match()), 1);
});

test("BOTS COUNT: a quest does not care who was in the lobby", () => {
  // Deliberate. A quest you cannot attempt because nobody is online is worse
  // than one that is occasionally easy — the farm is closed by the match
  // eligibility gates instead.
  const quest = questById("topThree")!;
  const botLobby = match({ playerCount: 7, humanCount: 1 });
  assert.ok(contribution(quest, roll("topThree"), seat(), botLobby) > 0);
});

test('"in a single match" keeps the BEST, it does not add up', () => {
  const quest = questById("dealDamageSingle")!; // accumulate: best
  const r = roll("dealDamageSingle");
  let state = fresh();
  state = advance(quest, r, state, seat({ stats: { ...seat().stats, damageDealt: 9000 } }), match());
  assert.equal(state.progress, 9000);
  state = advance(quest, r, state, seat({ stats: { ...seat().stats, damageDealt: 4000 } }), match());
  assert.equal(state.progress, 9000, "a worse match must not lower it");
  state = advance(quest, r, state, seat({ stats: { ...seat().stats, damageDealt: 12000 } }), match());
  assert.equal(state.progress, 12000, "and a better one raises it");
});

test("cumulative quests add every qualifying match", () => {
  const quest = questById("dealDamage")!; // accumulate: sum
  const r = roll("dealDamage");
  let state = fresh();
  for (let i = 0; i < 3; i++) {
    state = advance(quest, r, state, seat({ stats: { ...seat().stats, damageDealt: 5000 } }), match());
  }
  assert.equal(state.progress, 15000);
});

test('"different kingdoms" refuses to count the same one twice', () => {
  const quest = questById("winThreeKingdoms")!;
  const r = roll("winThreeKingdoms");
  let state = fresh();

  state = advance(quest, r, state, seat({ kingdomId: "fire" }), match());
  assert.equal(state.progress, 1);
  state = advance(quest, r, state, seat({ kingdomId: "fire" }), match());
  assert.equal(state.progress, 1, "the same kingdom again is worth nothing");
  state = advance(quest, r, state, seat({ kingdomId: "water" }), match());
  assert.equal(state.progress, 2);
  state = advance(quest, r, state, seat({ kingdomId: "ice" }), match());
  assert.equal(state.progress, 3);
  assert.equal(state.completed, true);
});

test("a completed quest stops accumulating", () => {
  // Otherwise progress climbs past the target, and a later retune could
  // "un-complete" somebody who had already been paid.
  const quest = questById("dealDamage")!;
  const r = roll("dealDamage");
  let state: QuestState = { progress: quest.target, seenKingdoms: [], completed: true };
  const after = advance(quest, r, state, seat(), match());
  assert.equal(after, state, "an untouched state is returned as-is");
});

test("a non-qualifying match leaves the state untouched", () => {
  const quest = questById("winAsKingdom1")!;
  const r = roll("winAsKingdom1", "fire");
  const state = fresh();
  assert.equal(advance(quest, r, state, seat({ placement: 4 }), match()), state);
});

test("health-remaining reads the castle, and only on a win", () => {
  const quest = questById("winHealthy")!;
  const r = roll("winHealthy");
  assert.equal(contribution(quest, r, seat({ placement: 1, hpRemaining: 7200 }), match()), 7200);
  assert.equal(contribution(quest, r, seat({ placement: 2, hpRemaining: 7200 }), match()), 0);
});

test("shielded damage is counted separately from damage taken", () => {
  const quest = questById("shieldDamage")!;
  const s = seat({ stats: { ...seat().stats, damageTaken: 5000, damageShielded: 1200 } });
  assert.equal(contribution(quest, roll("shieldDamage"), s, match()), 1200);
});
