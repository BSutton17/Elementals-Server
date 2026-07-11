import { test } from "node:test";
import assert from "node:assert/strict";
import { ReconnectionManager } from "../src/net/ReconnectionManager.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("fires the expiry callback after the delay", async () => {
  const rm = new ReconnectionManager();
  let fired = false;
  rm.schedule("1234", "p1", 30, () => {
    fired = true;
  });
  assert.ok(rm.has("1234", "p1"));
  assert.equal(rm.pendingCount, 1);

  await wait(70);
  assert.ok(fired);
  assert.equal(rm.pendingCount, 0);
});

test("cancel prevents the expiry callback", async () => {
  const rm = new ReconnectionManager();
  let fired = false;
  rm.schedule("1234", "p1", 40, () => {
    fired = true;
  });
  assert.equal(rm.cancel("1234", "p1"), true);
  assert.equal(rm.cancel("1234", "p1"), false); // already cleared

  await wait(80);
  assert.equal(fired, false);
  assert.equal(rm.pendingCount, 0);
});

test("scheduling again replaces the previous timer", async () => {
  const rm = new ReconnectionManager();
  let count = 0;
  rm.schedule("1234", "p1", 30, () => count++);
  rm.schedule("1234", "p1", 30, () => count++); // replaces the first

  await wait(70);
  assert.equal(count, 1);
});
