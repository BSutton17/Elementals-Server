import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { activateAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { earn } from "../src/engine/money.js";
import { selectTarget } from "../src/engine/targeting.js";
import { computeIncome } from "../src/engine/economy.js";
import { standingCentrepiece } from "../src/engine/centrepiece.js";
import {
  damageMonster,
  monsterIsAlive,
  resolveMonster,
  runMonsterAttacks,
  spawnMonster,
  tickMonsterSpawn,
} from "../src/engine/monster.js";
import { MONSTER_TARGET_ID } from "../src/match/GameState.js";
import { THE_END_OF_THE_WORLD } from "../src/data/magmaAbilities.js";
import { MONSTER, TICK } from "../src/data/balance.js";
import type { GameplayEvent } from "../src/engine/events.js";
import type { MatchPlayer } from "../src/match/types.js";

// The monster: the one thing in the middle of the field that nobody summoned,
// and the only one with no clock on it.

const matchPlayer = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
});

/**
 * A funded table.
 *
 * `rng` is injected rather than left to Math.random: every rule here is a dice
 * roll, and a test that hopes for a 3-in-4 is a test that fails one run in four.
 */
function table(
  kingdoms: readonly string[] = ["fire", "water", "earth"],
  rng: () => number = () => 0,
): Match {
  const match = new Match("1234", { rng });
  kingdoms.forEach((k, i) => match.addPlayer(matchPlayer(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  for (const p of match.gameState!.getPlayers()) earn(p, 1_000_000);
  return match;
}

function runTicks(match: Match, count: number): void {
  for (let i = 0; i < count; i++) tickMatch(match, match.tick + 1);
}

/** Collects every event the match emits from now on. */
function record(match: Match): GameplayEvent[] {
  const seen: GameplayEvent[] = [];
  match.gameState!.events.on((e) => seen.push(e));
  return seen;
}

const FIRST_ROLL_TICKS = MONSTER.FIRST_ROLL_SECONDS * TICK.RATE;
const INTERVAL_TICKS = MONSTER.ROLL_INTERVAL_SECONDS * TICK.RATE;

// --- spawning ----------------------------------------------------------------

test("nothing spawns before the first roll, however lucky the dice", () => {
  // rng 0 always passes the chance check, so if the clock were wrong this would
  // spawn one on tick 1.
  const match = table(["fire", "water", "earth"], () => 0);
  runTicks(match, FIRST_ROLL_TICKS - 1);
  assert.equal(match.gameState!.monster, null, "spawned before 1:30");

  runTicks(match, 1);
  assert.ok(match.gameState!.monster, "did not spawn on the first roll");
});

test("the spawn chance is the living kingdom count over ten", () => {
  // Three living kingdoms is 3/10. A roll of 0.29 passes, 0.31 does not — which
  // pins the divisor, not merely "some chance happened".
  for (const [roll, expected] of [
    [0.29, true],
    [0.31, false],
  ] as const) {
    const match = table(["fire", "water", "earth"], () => roll);
    runTicks(match, FIRST_ROLL_TICKS);
    assert.equal(
      match.gameState!.monster !== null,
      expected,
      `roll ${roll} with 3 living kingdoms`,
    );
  }
});

test("health is 2000 per living kingdom, fixed at the moment it lands", () => {
  const match = table(["fire", "water", "earth", "ice"], () => 0);
  runTicks(match, FIRST_ROLL_TICKS);
  const monster = match.gameState!.monster!;
  assert.equal(monster.maxHp, MONSTER.HP_PER_PLAYER * 4);

  // A kingdom dying afterwards does not shrink the wall the table already faces.
  match.gameState!.getPlayer("p3")!.eliminated = true;
  runTicks(match, 10);
  assert.equal(match.gameState!.monster!.maxHp, MONSTER.HP_PER_PLAYER * 4);
});

test("a missed roll waits a full interval before trying again", () => {
  // Fails the first roll, passes every one after it.
  let rolls = 0;
  const match = table(["fire", "water", "earth"], () => (rolls++ === 0 ? 0.9 : 0));
  runTicks(match, FIRST_ROLL_TICKS);
  assert.equal(match.gameState!.monster, null);

  runTicks(match, INTERVAL_TICKS - 1);
  assert.equal(match.gameState!.monster, null, "rolled early");
  runTicks(match, 1);
  assert.ok(match.gameState!.monster, "did not roll again after 30s");
});

test("the clock is frozen while another centrepiece holds the field", () => {
  // Magma's volcano goes up before the first roll comes due. While it stands
  // the clock does not advance at all — so the roll lands a full volcano's
  // worth of ticks late, rather than the moment the mountain clears.
  const match = table(["magma", "water", "earth"], () => 0);
  const magma = match.gameState!.getPlayer("p0")!;
  assert.equal(unlockOrUpgradeAbility(match, magma, THE_END_OF_THE_WORLD.id).ok, true);

  runTicks(match, FIRST_ROLL_TICKS - 200);
  assert.equal(activateAbility(match, magma, THE_END_OF_THE_WORLD).ok, true);
  assert.equal(standingCentrepiece(match)?.name, "The End of the World");

  // Straight through where the roll WOULD have been, had the clock kept running.
  runTicks(match, 200);
  assert.equal(match.gameState!.monster, null, "spawned while the volcano stood");
});

test("killing one buys a skipped roll before another can appear", () => {
  const match = table(["fire", "water", "earth"], () => 0);
  runTicks(match, FIRST_ROLL_TICKS);
  assert.ok(match.gameState!.monster);

  // Kill it outright.
  damageMonster(match, "p0", 999_999);
  runTicks(match, 1);
  assert.equal(match.gameState!.monster, null, "the kill did not resolve");

  // The next roll comes due and is thrown away, even on a guaranteed dice roll.
  runTicks(match, INTERVAL_TICKS);
  assert.equal(match.gameState!.monster, null, "spawned on the skipped roll");

  // The one after that is live again.
  runTicks(match, INTERVAL_TICKS);
  assert.ok(match.gameState!.monster, "never came back");
});

// --- the centre of the field -------------------------------------------------

test("a standing monster locks out the centrepiece ultimates", () => {
  const match = table(["magma", "water", "earth"], () => 0);
  const magma = match.gameState!.getPlayer("p0")!;
  assert.equal(unlockOrUpgradeAbility(match, magma, THE_END_OF_THE_WORLD.id).ok, true);

  runTicks(match, FIRST_ROLL_TICKS);
  assert.ok(monsterIsAlive(match));
  assert.equal(standingCentrepiece(match)?.name, "The Monster");

  const refused = activateAbility(match, magma, THE_END_OF_THE_WORLD);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "FIELD_OCCUPIED");

  // …and a refused cast costs nothing, so the ultimate is not squandered.
  damageMonster(match, "p1", 999_999);
  runTicks(match, 1);
  assert.equal(activateAbility(match, magma, THE_END_OF_THE_WORLD).ok, true);
});

test("everyone may aim at it, with no owner exemption", () => {
  const match = table(["fire", "water", "earth"], () => 0);
  runTicks(match, FIRST_ROLL_TICKS);
  for (const player of match.gameState!.getPlayers()) {
    assert.equal(
      selectTarget(match, player, MONSTER_TARGET_ID).ok,
      true,
      `${player.id} could not aim at the monster`,
    );
  }
});

test("it cannot be aimed at once it is dead", () => {
  const match = table(["fire", "water", "earth"], () => 0);
  runTicks(match, FIRST_ROLL_TICKS);
  damageMonster(match, "p0", 999_999);
  runTicks(match, 1);
  const result = selectTarget(match, match.gameState!.getPlayer("p0")!, MONSTER_TARGET_ID);
  assert.equal(result.ok, false);
  assert.equal(result.error, "INVALID_TARGET");
});

// --- the attack cycle --------------------------------------------------------

test("one roll decides the whole table: everybody, or nobody", () => {
  // The chance roll is the SECOND roll of a cycle (the delay is rolled first),
  // so the rng is stepped deliberately rather than pinned to one value.
  const rolls = [0.5]; // delay
  let i = 0;
  const match = table(["fire", "water", "earth"], () => rolls[i++ % rolls.length] ?? 0);

  spawnMonster(match);
  const monster = match.gameState!.monster!;
  const hpBefore = match.gameState!.getPlayers().map((p) => p.castle.hp);

  // A cycle that misses: rng returns 0.99, above the 0.75 threshold.
  monster.nextAttackTick = match.tick;
  match.rng = () => 0.99;
  runMonsterAttacks(match);
  assert.deepEqual(
    match.gameState!.getPlayers().map((p) => p.castle.hp),
    hpBefore,
    "a missed cycle still hurt somebody",
  );

  // A cycle that lands: everybody takes the same number. Shields are cleared
  // first — a kingdom whose passive opens with one would otherwise be reported
  // as "not hit" when it was in fact hit and absorbed it, which is a different
  // rule (covered below) than the one under test here.
  for (const p of match.gameState!.getPlayers()) p.castle.shield = 0;
  monster.nextAttackTick = match.tick;
  match.rng = () => 0.1;
  runMonsterAttacks(match);
  for (const p of match.gameState!.getPlayers()) {
    assert.equal(
      p.castle.hp,
      p.castle.maxHp - MONSTER.ATTACK_DAMAGE,
      `${p.id} was not hit for the full amount`,
    );
  }
});

test("a landed cycle escalates once, not once per kingdom hit", () => {
  const match = table(["fire", "water", "earth", "ice", "nature"], () => 0.1);
  spawnMonster(match);
  const monster = match.gameState!.monster!;
  assert.equal(monster.attackDamage, MONSTER.ATTACK_DAMAGE);

  // rng 0.1 lands the cycle and rolls the low end of the escalation band.
  monster.nextAttackTick = match.tick;
  runMonsterAttacks(match);

  const escalation = monster.attackDamage - MONSTER.ATTACK_DAMAGE;
  assert.ok(
    escalation >= MONSTER.ATTACK_ESCALATION_MIN &&
      escalation <= MONSTER.ATTACK_ESCALATION_MAX,
    `escalated by ${escalation}, outside one roll of the band — five castles were hit`,
  );
});

test("a missed cycle escalates nothing", () => {
  const match = table(["fire", "water", "earth"], () => 0.99);
  spawnMonster(match);
  const monster = match.gameState!.monster!;
  monster.nextAttackTick = match.tick;
  runMonsterAttacks(match);
  assert.equal(monster.attackDamage, MONSTER.ATTACK_DAMAGE);
});

test("a shield stops a cycle dead, whatever is left of it", () => {
  const match = table(["fire", "water", "earth"], () => 0.1);
  spawnMonster(match);
  const monster = match.gameState!.monster!;

  const shielded = match.gameState!.getPlayer("p0")!;
  // One point of shield. Overflow is DISCARDED rather than carried to HP, so
  // this is a complete answer to the cycle and not a 1-damage reduction.
  shielded.castle.shield = 1;
  const bare = match.gameState!.getPlayer("p1")!;

  monster.nextAttackTick = match.tick;
  runMonsterAttacks(match);

  assert.equal(shielded.castle.hp, shielded.castle.maxHp, "it punched through a shield");
  assert.equal(shielded.castle.shield, 0);
  assert.equal(bare.castle.hp, bare.castle.maxHp - MONSTER.ATTACK_DAMAGE);
});

test("it can finish off an unshielded castle", () => {
  const match = table(["fire", "water", "earth"], () => 0.1);
  spawnMonster(match);
  const monster = match.gameState!.monster!;

  const doomed = match.gameState!.getPlayer("p0")!;
  doomed.castle.hp = 10;
  doomed.castle.shield = 0;

  monster.nextAttackTick = match.tick;
  runTicks(match, 1);
  assert.equal(doomed.castle.hp, 0);
  assert.equal(doomed.eliminated, true, "the castle survived a fatal cycle");
});

// --- the rewards -------------------------------------------------------------

/** The multiplier a player's income is currently under, from their modifiers. */
function incomeMultiplier(match: Match, id: string): number {
  const player = match.gameState!.getPlayer(id)!;
  return player.modifiers
    .filter((m) => m.stat === "income" && m.op === "mult")
    .reduce((product, m) => product * m.value, 1);
}

test("the last hit and the damage crown pay two different kingdoms", () => {
  const match = table(["fire", "water", "earth"], () => 0);
  spawnMonster(match);
  const monster = match.gameState!.monster!;

  // p0 does the heavy lifting; p1 steals the finish.
  damageMonster(match, "p0", monster.maxHp - 1);
  damageMonster(match, "p1", 1);

  const events = record(match);
  resolveMonster(match);

  assert.equal(incomeMultiplier(match, "p0"), MONSTER.REWARD_MULTIPLIER, "no damage crown");
  assert.equal(incomeMultiplier(match, "p1"), MONSTER.REWARD_MULTIPLIER, "no last-hit prize");
  assert.equal(incomeMultiplier(match, "p2"), 1, "a bystander was paid");

  const defeated = events.find((e) => e.type === "monsterDefeated");
  assert.ok(defeated && defeated.type === "monsterDefeated");
  assert.equal(defeated.lastHitBy, "p1");
  assert.equal(defeated.mostDamageBy, "p0");
});

test("one kingdom taking both gets 2.25x, and there is no runner-up", () => {
  const match = table(["fire", "water", "earth"], () => 0);
  spawnMonster(match);
  const monster = match.gameState!.monster!;

  // p1 chips at it; p0 does everything else including the kill.
  damageMonster(match, "p1", 100);
  damageMonster(match, "p0", monster.maxHp);

  resolveMonster(match);

  // 1.5 twice over, rather than a separate hard-coded "both" number.
  assert.equal(
    incomeMultiplier(match, "p0"),
    MONSTER.REWARD_MULTIPLIER ** 2,
    "the double reward did not compound",
  );
  assert.equal(incomeMultiplier(match, "p1"), 1, "second place was paid");
});

test("the reward actually multiplies gold production, then expires", () => {
  const match = table(["fire", "water", "earth"], () => 0);
  const player = match.gameState!.getPlayer("p0")!;
  const before = computeIncome(player);
  assert.ok(before > 0, "the seat earns nothing to multiply");

  spawnMonster(match);
  // p0 takes the damage crown only — p1 steals the finish — so this measures
  // exactly one reward rather than the compounded pair.
  damageMonster(match, "p0", match.gameState!.monster!.maxHp - 1);
  damageMonster(match, "p1", 1);
  resolveMonster(match);

  assert.ok(
    Math.abs(computeIncome(player) - before * MONSTER.REWARD_MULTIPLIER) < 0.01,
    "production was not multiplied",
  );

  runTicks(match, MONSTER.REWARD_DURATION_SECONDS * TICK.RATE + 1);
  assert.ok(
    Math.abs(computeIncome(player) - before) < 0.01,
    "the reward never expired",
  );
});

test("an eliminated kingdom collects nothing, and nobody inherits it", () => {
  const match = table(["fire", "water", "earth"], () => 0);
  spawnMonster(match);
  const monster = match.gameState!.monster!;

  // p0 out-damages everyone and then dies before the kill lands.
  damageMonster(match, "p0", monster.maxHp - 1);
  match.gameState!.getPlayer("p0")!.eliminated = true;
  damageMonster(match, "p1", 1);

  resolveMonster(match);
  assert.equal(incomeMultiplier(match, "p0"), 1, "a dead castle was paid");
  assert.equal(incomeMultiplier(match, "p1"), MONSTER.REWARD_MULTIPLIER, "no last-hit prize");
  assert.equal(incomeMultiplier(match, "p2"), 1, "the runner-up inherited the share");
});

test("damage over time counts toward both rewards", () => {
  // A burn is credited to whoever set it, so a kingdom that cannot out-swing
  // anybody can still take the crown and the finishing blow with a DoT.
  const match = table(["fire", "water", "earth"], () => 0);
  spawnMonster(match);
  const monster = match.gameState!.monster!;
  monster.statuses.push({
    id: "burn",
    sourceId: "p2",
    remainingTicks: 0,
    stacks: 1,
    tickEffects: [{ type: "damage", amount: monster.maxHp }],
  });

  runTicks(match, 1);
  assert.equal(match.gameState!.monster, null, "the burn did not finish it");
  assert.equal(incomeMultiplier(match, "p2"), MONSTER.REWARD_MULTIPLIER ** 2);
});

// --- the spawn clock in isolation -------------------------------------------

test("the clock is armed lazily, so a parameter override still lands", () => {
  const match = table(["fire", "water", "earth"], () => 0);
  assert.equal(match.gameState!.monsterSpawn, null, "armed before the first tick");
  tickMonsterSpawn(match);
  assert.equal(
    match.gameState!.monsterSpawn!.ticksUntilRoll,
    FIRST_ROLL_TICKS - 1,
    "the first interval is not 90 seconds",
  );
});
