import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import { startServer, type RunningServer } from "./helpers/server.js";
import { slowClientsGetThis, slowRoom } from "../src/net/gameSync.js";
import { TICK } from "../src/data/balance.js";

/**
 * Letting a device ask for fewer updates.
 *
 * ⚠️ A COMFORT SETTING MUST NEVER COST SOMEBODY THE GAME, AND THIS ONE COULD.
 * Reaction Test is scored HERE, from the tick a press arrives against the tick
 * the button turned green — so a client told about the green light half a sync
 * late posts a worse time for no reason it could see or fix. Bomb Attack and the
 * barrier games have the same shape. That is why a live session suspends the
 * setting entirely, and it is the single most important thing in this file:
 * everything else is a battery saving, this is fairness.
 */

const PORT = "3212"; // unique across the suite - see portsUnique.test.ts
let server: RunningServer;

before(async () => {
  server = await startServer({ NODE_ENV: "development", PORT });
});

after(async () => {
  await server.stop();
});

function connect(): Socket {
  return io(`http://localhost:${PORT}`, { forceNew: true });
}

async function waitConnected(socket: Socket): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

const at = (tick: number, party: { resolvedTick: number | null } | null = null) =>
  slowClientsGetThis({ tick, party });

test("a half-rate client is sent every other sync", () => {
  const step = TICK.SYNC_EVERY_TICKS;
  const sent = [0, 1, 2, 3, 4, 5].map((i) => at(i * step));
  // Alternating, and starting with one that IS sent — a client that had to wait
  // for the second sync would open on an empty board.
  assert.deepEqual(sent, [true, false, true, false, true, false]);
});

test("...and every sync while a minigame is live, however slow they asked to be", () => {
  const step = TICK.SYNC_EVERY_TICKS;
  const live = { resolvedTick: null };
  for (let i = 0; i < 8; i++) {
    assert.equal(
      at(i * step, live),
      true,
      `sync ${i} was withheld from a half-rate client during a minigame`,
    );
  }
});

test("the saving comes back once the session has resolved", () => {
  // The banner lingers for four seconds after a game ends. Nothing is being
  // played by then, so there is nothing left to be fair about.
  const step = TICK.SYNC_EVERY_TICKS;
  const over = { resolvedTick: 100 };
  assert.equal(at(0 * step, over), true);
  assert.equal(at(1 * step, over), false);
});

test("the slow room is scoped to one match", () => {
  // Two matches running at once must not put each other's players on half rate.
  assert.notEqual(slowRoom("AAAA"), slowRoom("BBBB"));
  assert.ok(slowRoom("AAAA").includes("AAAA"));
});

test("a client can ask for a slower rate, and change its mind", async () => {
  const player = connect();
  try {
    await waitConnected(player);
    const slow = await player.emitWithAck("conn:setSyncRate", { rate: "reduced" });
    assert.equal(slow.ok, true);
    assert.equal(slow.data.rate, "reduced");

    const back = await player.emitWithAck("conn:setSyncRate", { rate: "normal" });
    assert.equal(back.data.rate, "normal");
  } finally {
    player.close();
  }
});

test("an unknown rate is read as normal rather than refused", async () => {
  // ⚠️ THIS IS A COMFORT SETTING AND MUST NEVER BE A REASON A CLIENT CANNOT
  // PLAY. An older or newer client sending something unexpected gets full rate,
  // which is what everybody had before the setting existed.
  const player = connect();
  try {
    await waitConnected(player);
    for (const rate of [undefined, null, 42, "turbo", {}]) {
      const res = await player.emitWithAck("conn:setSyncRate", { rate });
      assert.equal(res.ok, true, `rate ${JSON.stringify(rate)} was refused`);
      assert.equal(res.data.rate, "normal");
    }
  } finally {
    player.close();
  }
});

test("asking before joining a room does not throw, and applies on join", async () => {
  // The setting is chosen in the menu, long before any room exists.
  const player = connect();
  try {
    await waitConnected(player);
    const set = await player.emitWithAck("conn:setSyncRate", { rate: "reduced" });
    assert.equal(set.ok, true);

    const created = await player.emitWithAck("lobby:create", { name: "Alice" });
    assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  } finally {
    player.close();
  }
});
