import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, type RunningServer } from "./helpers/server.js";

// Sign-in endpoint (POST /auth/google).
//
// These tests deliberately do NOT verify a real Google token — that would mean
// calling Google from CI. What matters here is the shape around the exchange:
// bad input is refused, the browser's preflight is answered, and none of it
// disturbs the routes that were already there.

const PORT = "3209"; // unique across the suite - see portsUnique.test.ts
const ORIGIN = "http://localhost:5173";
let server: RunningServer;

before(async () => {
  server = await startServer({ NODE_ENV: "development", PORT });
});

after(async () => {
  await server.stop();
});

const post = (body: unknown, origin = ORIGIN) =>
  fetch(`http://localhost:${PORT}/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });

test("a garbage token is rejected with 401", async () => {
  const res = await post({ idToken: "not-a-real-google-token" });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_token");
});

test("a missing token is rejected the same way", async () => {
  const res = await post({});
  assert.equal(res.status, 401);
});

test("the failure reply never explains WHY it failed", async () => {
  // A caller who can tell "malformed" from "expired" from "wrong audience" is
  // a caller being helped to probe. Every failure looks identical.
  const [garbage, missing, wrongType] = await Promise.all([
    post({ idToken: "aaa.bbb.ccc" }),
    post({}),
    post({ idToken: 12345 }),
  ]);
  const bodies = await Promise.all([garbage.json(), missing.json(), wrongType.json()]);
  for (const body of bodies) {
    assert.deepEqual(body, { error: "invalid_token" });
  }
});

test("the browser's CORS preflight is answered", async () => {
  // Without this the browser never sends the real POST, and the console shows
  // a CORS error that reads as though the endpoint is broken.
  const res = await fetch(`http://localhost:${PORT}/auth/google`, {
    method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /Content-Type/);
});

test("responses carry CORS headers and Vary: Origin", async () => {
  const res = await post({ idToken: "nope" });
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  // Without Vary, a proxy could cache one origin's response for another.
  assert.match(res.headers.get("vary") ?? "", /Origin/);
});

test("an unlisted origin does not get itself echoed back", async () => {
  const res = await post({ idToken: "nope" }, "https://evil.example.com");
  assert.notEqual(res.headers.get("access-control-allow-origin"), "https://evil.example.com");
});

test("the existing routes still behave", async () => {
  // Sign-in was added to the same listener that serves these; a regression
  // here would take the Heroku health check down with it.
  const health = await fetch(`http://localhost:${PORT}/health`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { status: string }).status, "ok");

  const missing = await fetch(`http://localhost:${PORT}/does-not-exist`);
  assert.equal(missing.status, 404);

  // GET on the sign-in path is not a route.
  const wrongMethod = await fetch(`http://localhost:${PORT}/auth/google`);
  assert.equal(wrongMethod.status, 404);
});
