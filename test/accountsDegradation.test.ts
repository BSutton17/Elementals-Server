import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import { startServer, type RunningServer } from "./helpers/server.js";
import { getDb, isDatabaseConfigured } from "../src/db/client.js";
import { findOrCreateAccount, getProfile } from "../src/db/accounts.js";

// What happens when there is NO DATABASE.
//
// This is the property the whole persistence layer is built around: Kingdoms
// is a party game first and an account system second. Postgres being down,
// unreachable, or simply unconfigured must cost you sign-in and nothing else —
// room codes keep working, matches keep simulating, and everyone plays as a
// guest, which is a state the game already supports everywhere.
//
// These tests run with DATABASE_URL explicitly blanked so they prove the
// degraded path rather than accidentally testing a developer's live database.

const PORT = "3208"; // unique across the suite - see portsUnique.test.ts
let server: RunningServer;

before(async () => {
  server = await startServer({ NODE_ENV: "development", PORT, DATABASE_URL: "" });
});

after(async () => {
  await server.stop();
});

// --- the data layer degrades quietly -----------------------------------------

test("with no DATABASE_URL there is no connection, and asking is not an error", () => {
  assert.equal(isDatabaseConfigured(), false);
  assert.equal(getDb(), null);
});

test("account lookups return null instead of throwing", async () => {
  // Callers branch on null. If these threw, every call site would need a
  // try/catch and one missed catch would take a request down.
  const account = await findOrCreateAccount({
    provider: "google",
    providerUid: "whoever",
  });
  assert.equal(account, null);

  const profile = await getProfile("00000000-0000-0000-0000-000000000000");
  assert.equal(profile, null);
});

// --- the game does not care ---------------------------------------------------

test("the server boots without a database at all", () => {
  assert.match(server.output(), /Server listening/);
  // And the startup line SAYS accounts are off, rather than leaving an
  // operator to discover it from a player reporting that sign-in does nothing.
  assert.match(server.output(), /accounts: 'disabled \(no DATABASE_URL\)'/);
});

test("health still answers", async () => {
  const res = await fetch(`http://localhost:${PORT}/health`);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, "ok");
});

test("A PLAYER CAN STILL CONNECT AND PLAY", async () => {
  // The one that matters. A guest joining a friend's room must be completely
  // unaffected by the account system being unavailable.
  const socket: Socket = io(`http://localhost:${PORT}`, { forceNew: true });
  try {
    const id = await new Promise<string>((resolve, reject) => {
      socket.on("connect", () => resolve(socket.id ?? ""));
      socket.on("connect_error", (err) => reject(err));
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });
    assert.ok(id.length > 0, "a guest must still get a socket");

    // And can actually do the first thing a player does: open a room.
    const ack = await new Promise<{ ok: boolean }>((resolve, reject) => {
      socket.emit("lobby:create", { name: "Guest" }, (response: { ok: boolean }) =>
        resolve(response),
      );
      setTimeout(() => reject(new Error("lobby:create timed out")), 5000);
    });
    assert.equal(ack.ok, true, "creating a room must not depend on the database");
  } finally {
    socket.close();
  }
});

test("signing in reports a 503, not a crash and not a lie", async () => {
  // A caller with a genuinely bad token still gets 401 (that is their fault).
  // The 503 case needs a VALID Google token, which a test cannot mint — so
  // this asserts the reachable half: the endpoint answers rather than hanging
  // or 500-ing when accounts are unavailable.
  const res = await fetch(`http://localhost:${PORT}/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ idToken: "not-a-real-token" }),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "invalid_token" });
  assert.notEqual(res.status, 500, "an unavailable database must never surface as a crash");
});
