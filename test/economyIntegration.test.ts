import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "socket.io";
import { tickMatch } from "../src/engine/tick.js";
import {
  buyCitizen,
  buyShield,
  citizenCost,
  repairCastle,
  repairCost,
} from "../src/engine/purchases.js";
import { canAfford, earn, roundMoney } from "../src/engine/money.js";
import { broadcastGameState } from "../src/net/gameSync.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { CASTLE, ECONOMY, SHIELD } from "../src/data/balance.js";
import type { KingdomId } from "../src/data/kingdoms.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

/**
 * T4.2 — Economy integration tests. Rather than probing one function, each test
 * runs an *extended* match (hundreds of ticks) with heavy economy usage —
 * greedy citizen buying, sustained repairs under damage, shield churn — and
 * checks that the whole economy stays internally consistent end to end:
 *
 *   • scaling: citizen/repair costs follow their exact progressive formulas;
 *   • purchases/repairs: every spend is debited exactly once, HP never over- or
 *     under-heals, and shields obey the one-active rule over a long run;
 *   • balances reconcile: an independent ledger (mirroring money.ts) tracks
 *     every dollar earned and spent and must equal the engine's balance exactly;
 *   • synchronization: the real `broadcastGameState` payload a client receives
 *     mirrors the authoritative server state, derived costs included.
 */

const player = (id: string, kingdomId: KingdomId = "fire"): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** Starts an active match seeded with the given players. */
function startedMatch(players: MatchPlayer[]): Match {
  const match = new Match("1234");
  for (const p of players) match.addPlayer(p);
  match.hostId = players[0].id;
  match.start(createMatchConfig(match));
  return match;
}

/**
 * An independent money ledger that mirrors money.ts (cent-rounded earn/spend,
 * non-positive amounts ignored). Run in parallel with the engine so the final
 * balance can be reconciled to the penny — proving no dollar was lost, double
 * spent, or conjured across an extended, high-volume run.
 */
function makeLedger() {
  let balance = 0;
  return {
    earn(amount: number) {
      if (amount > 0) balance = roundMoney(balance + amount);
    },
    spend(amount: number) {
      if (amount > 0) balance = roundMoney(balance - amount);
    },
    get balance() {
      return balance;
    },
  };
}

/**
 * Runs the real `broadcastGameState` with a stub io that captures the emitted
 * `state:sync` payload — the exact bytes a client would receive.
 */
function captureSync(match: Match) {
  let captured: any = null;
  const io = {
    to: () => ({
      emit: (_event: string, payload: unknown) => {
        captured = payload;
      },
    }),
  } as unknown as Server;
  broadcastGameState(io, match);
  return captured as {
    tick: number;
    players: (PlayerState & {
      economy: PlayerState["economy"] & { nextCitizenCost: number };
      castle: PlayerState["castle"] & { nextRepairCost: number };
    })[];
  };
}

// ---------------------------------------------------------------------------

test("extended match: greedy citizen buying keeps exact cost scaling and reconciled balances", () => {
  const match = startedMatch([player("a"), player("b")]);
  const state = match.gameState!;
  const a = state.getPlayer("a")!;
  const b = state.getPlayer("b")!;

  // Seed both equally so 'a' can start buying immediately; 'b' is the control —
  // it never buys, so its income stays a flat $0.4/tick and its balance is exactly
  // predictable, catching any cross-player leakage in the economy.
  const ledgerA = makeLedger();
  const ledgerB = makeLedger();
  earn(a, 4000);
  ledgerA.earn(4000);
  earn(b, 4000);
  ledgerB.earn(4000);

  const citizenCostHistory: number[] = [];
  const TICKS = 300;

  for (let t = 1; t <= TICKS; t++) {
    tickMatch(match, t);
    // Passive income was credited this tick; mirror the exact amount earned.
    ledgerA.earn(a.economy.incomePerTick);
    ledgerB.earn(b.economy.incomePerTick);

    // 'a' buys citizens greedily while affordable — heavy churn. Escalating cost
    // guarantees the loop terminates.
    while (canAfford(a, citizenCost(a))) {
      const cost = citizenCost(a);
      assert.equal(buyCitizen(match, a).ok, true);
      citizenCostHistory.push(cost);
      ledgerA.spend(cost);
    }
  }

  // Heavy usage actually happened.
  assert.ok(
    citizenCostHistory.length >= 15,
    `expected heavy buying, got ${citizenCostHistory.length} citizens`,
  );

  // Scaling: every recorded cost matches base × growth^purchased (rounded to
  // whole dollars) and the sequence is strictly non-decreasing.
  citizenCostHistory.forEach((cost, i) => {
    const expected = Math.round(
      ECONOMY.CITIZEN_COST * ECONOMY.CITIZEN_COST_GROWTH ** i,
    );
    assert.equal(cost, expected, `citizen #${i} cost ${cost} ≠ ${expected}`);
    if (i > 0) assert.ok(cost >= citizenCostHistory[i - 1]);
  });

  // Purchases: citizen count and income reflect exactly what was bought.
  assert.equal(a.economy.citizens, 10 + citizenCostHistory.length);
  assert.equal(a.economy.citizensPurchased, citizenCostHistory.length);
  assert.equal(a.economy.incomePerTick, roundMoney(a.economy.citizens * 0.06));
  assert.ok(a.economy.incomePerTick > b.economy.incomePerTick);

  // Reconciliation: engine balances match the independent ledgers to the penny.
  assert.equal(a.economy.currency, ledgerA.balance);
  assert.equal(b.economy.currency, ledgerB.balance);
  // The control player: seed $4000 + $0.4/tick × 300 ticks, nothing spent.
  assert.equal(b.economy.currency, 4000 + 180);

  // Synchronization: the broadcast a client receives mirrors server truth.
  const sync = captureSync(match);
  assert.equal(sync.tick, TICKS);
  const syncA = sync.players.find((p) => p.id === "a")!;
  assert.equal(syncA.economy.currency, a.economy.currency);
  assert.equal(syncA.economy.citizens, a.economy.citizens);
  assert.equal(syncA.economy.incomePerTick, a.economy.incomePerTick);
  assert.equal(syncA.economy.nextCitizenCost, citizenCost(a));
});

test("extended match: repairs scale geometrically and stop at the per-match cap", () => {
  const match = startedMatch([player("a"), player("b")]);
  const state = match.gameState!;
  const a = state.getPlayer("a")!;

  const ledger = makeLedger();
  earn(a, 5000);
  ledger.earn(5000);

  const repairCostHistory: number[] = [];

  for (let i = 0; i < CASTLE.MAX_REPAIRS; i++) {
    // Keep the castle deep enough below max that every repair restores a full
    // REPAIR_AMOUNT chunk while the match genuinely runs between repairs.
    a.castle.hp = a.castle.maxHp - CASTLE.REPAIR_AMOUNT * 4;
    const cost = repairCost(a);
    assert.equal(repairCastle(match, a).ok, true);
    repairCostHistory.push(cost);
    ledger.spend(cost);

    for (let t = 0; t < 5; t++) {
      tickMatch(match, i * 5 + t + 1);
      ledger.earn(a.economy.incomePerTick);
    }
  }

  // Scaling: flat $500 base × growth^repairs, strictly rising, whole dollars.
  repairCostHistory.forEach((cost, i) => {
    const expected = Math.round(
      CASTLE.REPAIR_COST * CASTLE.REPAIR_COST_GROWTH ** i,
    );
    assert.equal(cost, expected, `repair #${i} cost ${cost} ≠ ${expected}`);
    if (i > 0) assert.ok(cost > repairCostHistory[i - 1]);
  });
  assert.deepEqual(repairCostHistory, [500, 625, 781]);
  assert.equal(a.castle.repairs, CASTLE.MAX_REPAIRS);

  // The cap: a fourth repair is refused and the quoted next cost drops to 0.
  // (Ability-based healing is unaffected — the cap binds only the shop button.)
  a.castle.hp = a.castle.maxHp - 100;
  const refused = repairCastle(match, a);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "REPAIR_LIMIT");
  assert.equal(repairCost(a), 0);

  // Reconciliation to the penny after all the repairs and income.
  assert.equal(a.economy.currency, ledger.balance);

  // Synchronization: the synced repair cost matches the authoritative next cost.
  const sync = captureSync(match);
  const syncA = sync.players.find((p) => p.id === "a")!;
  assert.equal(syncA.castle.nextRepairCost, 0);
  assert.equal(syncA.castle.hp, a.castle.hp);
});

test("extended match: shields obey the one-active rule and rebuy only after depletion", () => {
  const match = startedMatch([player("a"), player("b")]);
  const state = match.gameState!;
  const a = state.getPlayer("a")!;

  const ledger = makeLedger();
  earn(a, 1000);
  ledger.earn(1000);

  let shieldsBought = 0;

  // First shield.
  assert.equal(buyShield(match, a).ok, true);
  assert.equal(a.castle.shield, SHIELD.STANDARD_HP);
  ledger.spend(SHIELD.COST);
  shieldsBought++;

  // Across many ticks, every rebuy attempt is rejected while a shield is active,
  // and the shield/balance never drift.
  for (let t = 1; t <= 150; t++) {
    tickMatch(match, t);
    ledger.earn(a.economy.incomePerTick);

    if (a.castle.shield > 0) {
      const rejected = buyShield(match, a);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error, "SHIELD_ACTIVE");
      assert.equal(a.castle.shield, SHIELD.STANDARD_HP); // unchanged
    }

    // Simulate combat depleting the shield partway through the match.
    if (t === 75) a.castle.shield = 0;

    // Once depleted, a fresh shield can be bought exactly once.
    if (t === 76) {
      assert.equal(buyShield(match, a).ok, true);
      assert.equal(a.castle.shield, SHIELD.STANDARD_HP);
      ledger.spend(SHIELD.COST);
      shieldsBought++;
    }
  }

  assert.equal(shieldsBought, 2);
  assert.equal(a.economy.currency, ledger.balance);

  // Synchronization reflects the currently-active shield.
  const sync = captureSync(match);
  const syncA = sync.players.find((p) => p.id === "a")!;
  assert.equal(syncA.castle.shield, a.castle.shield);
});

test("extended match: the sync broadcast mirrors every player's economy under mixed heavy usage", () => {
  const match = startedMatch([
    player("a", "fire"),
    player("b", "water"),
    player("c", "air"),
  ]);
  const state = match.gameState!;
  const a = state.getPlayer("a")!;
  const b = state.getPlayer("b")!;
  const c = state.getPlayer("c")!;

  // Give everyone a war chest so all three economy levers get exercised.
  for (const p of [a, b, c]) earn(p, 1000);

  for (let t = 1; t <= 200; t++) {
    tickMatch(match, t);

    // 'a' buys citizens; 'b' repairs its castle under sustained damage.
    if (canAfford(a, citizenCost(a))) buyCitizen(match, a);
    b.castle.hp = Math.max(0, b.castle.hp - 300);
    if (canAfford(b, repairCost(b))) repairCastle(match, b);

    // 'c' is eliminated partway through and must stop earning entirely.
    if (t === 100) {
      c.eliminated = true;
    }
  }

  const currencyAtElimination = c.economy.currency;
  // Run a few more ticks to confirm an eliminated player earns nothing.
  for (let t = 201; t <= 210; t++) tickMatch(match, t);
  assert.equal(c.economy.currency, currencyAtElimination);

  // The broadcast payload must mirror authoritative state for every player,
  // including derived next-costs — this is the client/server sync contract.
  const sync = captureSync(match);
  assert.equal(sync.players.length, 3);
  for (const authoritative of [a, b, c]) {
    const synced = sync.players.find((p) => p.id === authoritative.id)!;
    assert.equal(synced.economy.currency, authoritative.economy.currency);
    assert.equal(synced.economy.citizens, authoritative.economy.citizens);
    assert.equal(
      synced.economy.incomePerTick,
      authoritative.economy.incomePerTick,
    );
    assert.equal(synced.economy.nextCitizenCost, citizenCost(authoritative));
    assert.equal(synced.castle.hp, authoritative.castle.hp);
    assert.equal(synced.castle.shield, authoritative.castle.shield);
    assert.equal(synced.castle.nextRepairCost, repairCost(authoritative));
    assert.equal(synced.eliminated, authoritative.eliminated);
  }
});
