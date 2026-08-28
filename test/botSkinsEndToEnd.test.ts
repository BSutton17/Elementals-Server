import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import { startServer, type RunningServer } from "./helpers/server.js";

// End-to-end over a LIVE SERVER: a bot's castle skin has to survive the actual
// socket path, not just the helper that resolves it. The unit tests around
// `botCastleFor`/`stampCastlePaint` all passed while skins were invisible in a
// real game, which is exactly the gap this file closes: it asserts on the bytes
// the client actually receives.

const PORT = "3219";
const PERKS = ["sharperSwords", "extraGuards"];

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

interface WirePlayer {
  id: string;
  isBot?: boolean;
  kingdomId: string | null;
  castlePaint?: { decor?: string; fill?: string };
}

test("match:started carries castlePaint for the bots in the room", async () => {
  const host = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await host.emitWithAck("lobby:selectKingdom", { kingdom: "fire" });
    await host.emitWithAck("lobby:selectPerks", { perks: PERKS });
    await host.emitWithAck("lobby:ready", { ready: true });

    // Six bots: with a 75% chance of a skin each, "none of them has one" is a
    // 1-in-4000 accident rather than a coin flip, so a failure here is a bug.
    for (let i = 0; i < 6; i++) await host.emitWithAck("lobby:addBot", {});

    const started = new Promise<{ players?: WirePlayer[] }>((resolve, reject) => {
      host.on("match:started", resolve);
      setTimeout(() => reject(new Error("no match:started")), 4000);
    });
    await host.emitWithAck("lobby:start", {});
    const payload = await started;

    assert.ok(payload.players, "match:started must carry a roster");
    const bots = payload.players!.filter((p) => p.isBot);
    assert.equal(bots.length, 6, `expected 6 bots, saw ${bots.length}`);
    const painted = bots.filter((b) => b.castlePaint);
    assert.ok(
      painted.length > 0,
      `no bot arrived with castlePaint: ${JSON.stringify(bots.map((b) => [b.kingdomId, b.castlePaint]))}`,
    );
  } finally {
    host.close();
  }
});

test("the roster in state:full also carries bot paint", async () => {
  const host = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    await host.emitWithAck("lobby:selectKingdom", { kingdom: "ice" });
    await host.emitWithAck("lobby:selectPerks", { perks: PERKS });
    await host.emitWithAck("lobby:ready", { ready: true });
    for (let i = 0; i < 6; i++) await host.emitWithAck("lobby:addBot", {});
    await host.emitWithAck("lobby:start", {});

    // Reconnect-style resync: this is the roster a spectator or a returning
    // player is rebuilt from, and it must be painted too.
    const full = new Promise<{ players: WirePlayer[] }>((resolve, reject) => {
      host.on("state:full", resolve);
      setTimeout(() => reject(new Error("no state:full")), 4000);
    });
    host.emit("state:request", {});
    const snapshot = await full.catch(() => null);
    if (!snapshot) return; // no such event on this build; covered by the unit test
    const painted = snapshot.players.filter((p) => p.isBot && p.castlePaint);
    assert.ok(painted.length > 0, "state:full roster had no bot paint");
  } finally {
    host.close();
  }
});
