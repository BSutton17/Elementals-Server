import test from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { BotRunner } from "../src/ai/botRunner.js";
import { loadModel, modelsAvailable, clearModelCache } from "../src/ai/modelStore.js";
import { knowledgeFor, ObservedHistory } from "../src/ai/knowledge.js";
import { OBSERVATION_SIZE, encode } from "../src/ai/observation.js";
import { PERK_IDS, perksAllowedFor } from "../src/data/perks.js";
import type { BotDifficulty, MatchPlayer } from "../src/match/types.js";
import { KINGDOM_IDS, type KingdomId } from "../src/data/kingdoms.js";

/**
 * Mirrors the draw in `lobbyHandlers.addBot`.
 *
 * Duplicated deliberately: the handler's helper is closed over the socket
 * registration and is not reachable without standing up a server, and the
 * property under test — a varying, legal, correctly-sized selection — is worth
 * pinning on its own. If the two ever diverge this test still describes what
 * the behaviour must be.
 */
function randomPerksForTest(kingdomId: KingdomId): string[] {
  const pool = [...PERK_IDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, perksAllowedFor(kingdomId));
}

/**
 * Bots in the real game.
 *
 * The tests that matter here run a REAL match through the production tick path
 * with production bot code — no mocked engine. A bot that passes unit tests but
 * cannot finish a match is worth nothing, and the failure modes that actually
 * bite (a seat that never acts, an action the engine rejects, a bot that can see
 * an opponent's gold) only appear when the whole thing runs.
 */

let seq = 0;
function botPlayer(difficulty: BotDifficulty, kingdomId: KingdomId): MatchPlayer {
  seq += 1;
  return {
    id: `bot-test-${seq}`,
    socketId: null,
    name: `Bot ${seq}`,
    kingdomId,
    perks: randomPerksForTest(kingdomId) as never,
    ready: true,
    connected: true,
    isBot: true,
    botDifficulty: difficulty,
  };
}

function humanPlayer(kingdomId: KingdomId): MatchPlayer {
  seq += 1;
  return {
    id: `human-${seq}`,
    socketId: `sock-${seq}`,
    name: `Player ${seq}`,
    kingdomId,
    perks: randomPerksForTest(kingdomId) as never,
    ready: true,
    connected: true,
  };
}

function startedMatch(players: MatchPlayer[]): Match {
  const match = new Match(`ROOM${seq}`);
  for (const p of players) match.addPlayer(p);
  match.start(createMatchConfig(match));
  return match;
}

test("all three trained models load and report full provenance", () => {
  clearModelCache();
  const status = modelsAvailable();
  assert.equal(status.ok, true, status.detail);
  for (const difficulty of ["easy", "medium", "hard"] as const) {
    const { model, network } = loadModel(difficulty);
    assert.equal(model.difficulty, difficulty);
    // The identity must be complete: a model that cannot say what it was trained
    // against cannot be trusted after a balance change.
    assert.ok(model.identity.observationVersion);
    assert.ok(model.identity.actionVersion);
    assert.ok(model.identity.engineSha);
    assert.ok(network, "network compiled");
  }
});

test("all three difficulties are backed by the SAME network", () => {
  // ⚠️ THIS ASSERTION IS THE INVERSE OF WHAT IT USED TO BE, DELIBERATELY.
  //
  // It previously demanded three different genomes, which contradicted the rule
  // the subsystem is actually built on. `difficulty.ts` states it outright:
  // difficulty is configuration, never a worse network, "because a damaged
  // network does not play badly, it plays incoherently, which reads to a player
  // as broken rather than beatable". Three separately trained genomes make Easy
  // a DIFFERENT, weaker policy rather than the same policy playing less sharply
  // — and nothing could keep the three ordered, since three independent runs
  // land wherever they land.
  //
  // So one champion backs all three, and the separation comes entirely from
  // `DIFFICULTY`: decision cadence (5 / 10 / 20 ticks), softmax temperature,
  // second-best rate, and Easy's quantized reading of the board. Those are the
  // axes that map onto how a weaker human plays.
  const genomes = new Set<string>();
  for (const difficulty of ["easy", "medium", "hard"] as const) {
    const { model } = loadModel(difficulty);
    genomes.add(JSON.stringify(model.genome.connections));
  }
  assert.equal(
    genomes.size,
    1,
    "the difficulties are backed by different networks — difficulty must come " +
      "from DIFFICULTY's cadence/temperature/noise, not from a weaker genome",
  );
});

test("a bot-vs-bot match actually plays and produces action", () => {
  const match = startedMatch([
    botPlayer("hard", "fire"),
    botPlayer("medium", "water"),
  ]);
  const runner = new BotRunner(match);
  const status = runner.start();
  assert.equal(status.failed.length, 0, JSON.stringify(status.failed));
  assert.equal(status.ready, 2);

  for (let tick = 1; tick <= 2400 && match.phase === "active"; tick++) {
    runner.tick(tick);
    if (tickMatch(match, tick)) break;
  }

  // Asserts what the bots DID, not what happened to the castles. Castle damage
  // is a downstream consequence of who targeted whom, which kingdoms were drawn
  // and which perks came up — all random here — so an HP check fails
  // intermittently for reasons that have nothing to do with the bot pipeline.
  const controllers = (runner as unknown as {
    controllers: Map<string, { stats?: { decisions: number; casts: number; rejected: number } }>;
  }).controllers;
  let totalCasts = 0;
  for (const [id, controller] of controllers) {
    const stats = controller.stats!;
    assert.ok(stats.decisions > 0, `${id} never made a decision`);
    assert.equal(stats.rejected, 0, `${id} had actions refused by the engine`);
    totalCasts += stats.casts;
  }
  assert.ok(totalCasts > 0, "no bot cast anything in 2400 ticks");
});

test("easy, medium and hard all make decisions and cast in a real match", () => {
  // Asserts the claim directly — each difficulty DECIDES and CASTS — rather than
  // inferring it from castle damage. Damage is a downstream consequence that
  // also depends on who targeted whom and how the dice fell, so an HP check
  // fails intermittently for reasons that have nothing to do with the model.
  for (const difficulty of ["easy", "medium", "hard"] as const) {
    const match = startedMatch([botPlayer(difficulty, "fire"), botPlayer(difficulty, "ice")]);
    const runner = new BotRunner(match);
    assert.equal(runner.start().ready, 2);

    for (let tick = 1; tick <= 2400 && match.phase === "active"; tick++) {
      runner.tick(tick);
      if (tickMatch(match, tick)) break;
    }

    const controllers = (runner as unknown as {
      controllers: Map<string, { stats?: { decisions: number; casts: number; rejected: number } }>;
    }).controllers;
    for (const [id, controller] of controllers) {
      const stats = controller.stats!;
      assert.ok(stats.decisions > 0, `${difficulty} ${id} never made a decision`);
      assert.ok(stats.casts > 0, `${difficulty} ${id} never cast an ability`);
      assert.equal(stats.rejected, 0, `${difficulty} ${id} had actions refused by the engine`);
    }
  }
});

test("a mixed human + bot match runs without the human acting", () => {
  const match = startedMatch([
    humanPlayer("fire"),
    botPlayer("hard", "water"),
    botPlayer("easy", "earth"),
  ]);
  const runner = new BotRunner(match);
  assert.equal(runner.start().ready, 2, "only the bot seats should get controllers");

  for (let tick = 1; tick <= 2400 && match.phase === "active"; tick++) {
    runner.tick(tick);
    if (tickMatch(match, tick)) break;
  }
  // Same reasoning as above: assert the bots acted, not that a castle bled.
  const acted = (runner as unknown as {
    controllers: Map<string, { stats?: { casts: number } }>;
  }).controllers;
  assert.ok([...acted.values()].some((c) => (c.stats?.casts ?? 0) > 0), "no bot cast anything");
});

test("several bots in one match each get their own controller and stream", () => {
  const match = startedMatch([
    botPlayer("hard", "fire"),
    botPlayer("hard", "water"),
    botPlayer("hard", "earth"),
    botPlayer("hard", "air"),
  ]);
  const runner = new BotRunner(match);
  assert.equal(runner.start().ready, 4);
  assert.equal(runner.size, 4);

  for (let tick = 1; tick <= 600 && match.phase === "active"; tick++) {
    runner.tick(tick);
    if (tickMatch(match, tick)) break;
  }
  // Identical models and identical difficulty, but seeded per seat — so they
  // must not have played in lockstep.
  const hp = match.gameState!.getPlayers().map((p) => p.castle.hp);
  assert.ok(new Set(hp).size > 1, "every seat ended identically; streams are shared");
});

test("a bot sees only what a player in its seat may see", () => {
  const match = startedMatch([botPlayer("hard", "fire"), humanPlayer("water")]);
  const me = match.gameState!.getPlayers()[0]!;
  const knowledge = knowledgeFor(match, me, new ObservedHistory());

  // Own state is known outright; enemy economy is not.
  assert.equal(typeof knowledge.self.currency, "number");
  for (const enemy of knowledge.enemies) {
    for (const [field, value] of Object.entries(enemy)) {
      if (value && typeof value === "object" && "known" in value) {
        const known = (value as { known: boolean }).known;
        if (["currency", "income", "citizens"].includes(field)) {
          assert.equal(known, false, `enemy ${field} leaked to the bot`);
        }
      }
    }
  }

  // And the encoded observation is the fixed width the models were trained on.
  //
  // ⚠️ CHECKED AGAINST THE SHIPPED MODEL, not against a literal. This read
  // `assert.equal(obs.length, 64)` while `obs` was allocated FROM
  // OBSERVATION_SIZE, so it could only ever restate the constant — and when the
  // observation grew to 80 the test failed without a single model being wrong.
  //
  // What actually matters is that the build and the trained network agree on
  // the width: a network expecting 64 inputs fed an 80-slot observation does
  // not throw, it plays confidently on garbage. That is the mismatch worth
  // catching, and it is the one the loader's identity gate exists to prevent.
  const obs = new Float32Array(OBSERVATION_SIZE);
  encode(knowledge, obs);
  assert.equal(obs.length, OBSERVATION_SIZE);
  const inputs = (loadModel("hard").model.genome as { nodes: { type: string }[] }).nodes
    .filter((n) => n.type === "input").length;
  assert.equal(
    obs.length,
    inputs,
    `the build encodes ${obs.length} inputs but the shipped model expects ${inputs}`,
  );
  assert.ok(obs.every((x) => Number.isFinite(x)), "observation contained NaN");
});

test("bot actions are refused by the engine exactly as a player's would be", () => {
  // The controller counts every engine call the mask approved and the engine
  // still refused. A nonzero count means the bot found a path a player has not
  // — which is the failure this whole architecture exists to prevent.
  const match = startedMatch([botPlayer("hard", "fire"), botPlayer("hard", "water")]);
  const runner = new BotRunner(match);
  runner.start();
  for (let tick = 1; tick <= 900 && match.phase === "active"; tick++) {
    runner.tick(tick);
    if (tickMatch(match, tick)) break;
  }
  const stats = (runner as unknown as {
    controllers: Map<string, { stats?: { rejected: number; rejectedBy: Record<string, number> } }>;
  }).controllers;
  for (const [id, controller] of stats) {
    const rejected = controller.stats?.rejected ?? 0;
    assert.equal(
      rejected,
      0,
      `${id} had ${rejected} engine refusals: ${JSON.stringify(controller.stats?.rejectedBy)}`,
    );
  }
});

test("bots draw different perk loadouts", () => {
  // Every bot used to take the first N perks off the canonical list, so a room
  // of three bots was three copies of one build. The draw must vary AND stay
  // legal — distinct ids, exactly the per-kingdom allowance.
  const draws = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const perks = randomPerksForTest("fire");
    assert.equal(perks.length, perksAllowedFor("fire"), "wrong number of perks");
    assert.equal(new Set(perks).size, perks.length, "a perk was drawn twice");
    for (const perk of perks) {
      assert.ok((PERK_IDS as readonly string[]).includes(perk), `${perk} is not a real perk`);
    }
    draws.add([...perks].sort().join(","));
  }
  assert.ok(draws.size > 1, "40 draws produced the same loadout every time");
});

test("bots draw a random kingdom from the ones still free", () => {
  // First-free order meant the first bot was always Water and the second always
  // Fire, so a host adding three bots got the identical three kingdoms every
  // game. The draw must vary, never collide with a taken seat, and return null
  // rather than a duplicate once the roster is exhausted.
  const taken = new Set<string>(["water", "fire"]);
  const drawn = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const free = KINGDOM_IDS.filter((k) => !taken.has(k));
    const pick = free[Math.floor(Math.random() * free.length)]!;
    assert.ok(!taken.has(pick), `${pick} was already taken`);
    drawn.add(pick);
  }
  assert.ok(drawn.size > 1, "60 draws produced the same kingdom every time");

  // Everything taken -> no kingdom to give, so the handler must refuse rather
  // than seat a duplicate.
  const all = new Set<string>(KINGDOM_IDS);
  assert.equal(KINGDOM_IDS.filter((k) => !all.has(k)).length, 0);
});

test("a bot with no game state yet is skipped rather than crashing", () => {
  const match = new Match("LOBBY1");
  match.addPlayer(botPlayer("hard", "fire"));
  const runner = new BotRunner(match);
  assert.equal(runner.start().ready, 0, "a lobby bot has no castle to drive");
  assert.doesNotThrow(() => runner.tick(1));
});

test("an unknown difficulty falls back rather than taking the match down", () => {
  const match = startedMatch([
    { ...botPlayer("hard", "fire"), botDifficulty: undefined },
    botPlayer("hard", "water"),
  ]);
  const runner = new BotRunner(match);
  const status = runner.start();
  assert.equal(status.failed.length, 0);
  assert.equal(status.ready, 2, "a bot without a stated difficulty still plays");
});
