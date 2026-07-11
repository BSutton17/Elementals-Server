import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRoomCode } from "../src/net/roomCode.js";
import { LOBBY } from "../src/data/balance.js";

const CODE_PATTERN = new RegExp(`^\\d{${LOBBY.ROOM_CODE_LENGTH}}$`);

test("produces a zero-padded numeric code of the configured length", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode();
    assert.match(code, CODE_PATTERN, `invalid code: ${code}`);
  }
});

test("never returns a code that isTaken reports as used", () => {
  const used = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const code = generateRoomCode((c) => used.has(c));
    assert.ok(!used.has(code));
    used.add(code);
  }
  // All generated codes were distinct (uniqueness against the growing set).
  assert.equal(used.size, 500);
});

test("throws when the code space is exhausted", () => {
  assert.throws(
    () => generateRoomCode(() => true),
    /Unable to generate a unique .* room code/,
  );
});
