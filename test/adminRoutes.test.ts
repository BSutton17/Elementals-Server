import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, type RunningServer } from "./helpers/server.js";

// The admin route over the wire.
//
// ⚠️ THE POINT OF THESE IS THE REFUSALS. Rerolling Featured changes the shop for
// every player in the game, so the interesting cases are the ones where it must
// not happen — no token, and a valid token belonging to somebody who is not an
// admin. The flag in the profile response only decides whether a button is
// drawn; this is what actually stops the action.

const PORT = "3220"; // unique across the suite - see portsUnique.test.ts
const ORIGIN = "http://localhost:5173";
const SECRET = "test-secret-for-admin-routes";

let server: RunningServer;

before(async () => {
  server = await startServer({ NODE_ENV: "development", PORT, JWT_SECRET: SECRET });
});

after(async () => {
  await server.stop();
});

const reroll = (headers: Record<string, string> = {}) =>
  fetch(`http://localhost:${PORT}/admin/shop/reroll`, {
    method: "POST",
    headers: { Origin: ORIGIN, ...headers },
  });

test("an anonymous caller cannot reroll the shop", async () => {
  const res = await reroll();
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: string }).error, "not_signed_in");
});

test("a bad token cannot reroll the shop", async () => {
  // Not 500, and not a silent success: an unreadable token is simply nobody.
  const res = await reroll({ Authorization: "Bearer not-a-real-token" });
  assert.equal(res.status, 401);
});

test("a signed-in non-admin is refused, and told why", async () => {
  // A real, valid session for an account that is not on the admin list. With no
  // database the admin lookup cannot confirm anyone, which is the same answer:
  // refused. Fail-closed is the property under test.
  const jwt = (await import("jsonwebtoken")).default;
  const token = jwt.sign({ sub: "11111111-1111-1111-1111-111111111111" }, SECRET, {
    expiresIn: "1h",
  });
  const res = await reroll({ Authorization: `Bearer ${token}` });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, "not_admin");
});

test("the route only answers POST", async () => {
  const res = await fetch(`http://localhost:${PORT}/admin/shop/reroll`, {
    headers: { Origin: ORIGIN },
  });
  assert.equal(res.status, 404);
});
