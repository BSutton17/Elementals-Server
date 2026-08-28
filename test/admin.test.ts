import { test } from "node:test";
import assert from "node:assert/strict";
import { isAdmin, isAdminEmail, clearAdminCache } from "../src/db/admin.js";
import { config } from "../src/config/index.js";
import { getInventory } from "../src/db/cosmetics.js";

// Who gets the admin tools, and what an admin can do.
//
// The membership rule is pure and tested here directly; the lookup that maps an
// account to its email addresses needs Postgres, so the tests that touch it
// assert the DEGRADED behaviour — which is the one that must not be permissive.

test("the owner's address is an admin out of the box", () => {
  // No configuration required for a fresh deployment to have one admin.
  assert.ok(isAdminEmail("btpitch27@gmail.com"));
  assert.deepEqual(config.admin.emails, ["btpitch27@gmail.com"]);
});

test("the address is matched case-insensitively and untrimmed input is fine", () => {
  // Google hands back whatever casing the user typed when they signed up, and
  // an admin who is an admin on Tuesday and not on Wednesday is a bug.
  assert.ok(isAdminEmail("Btpitch27@Gmail.com"));
  assert.ok(isAdminEmail("BTPITCH27@GMAIL.COM"));
  assert.ok(isAdminEmail("  btpitch27@gmail.com  "));
});

test("everyone else is not an admin, and a missing email is not either", () => {
  assert.equal(isAdminEmail("someone@example.com"), false);
  assert.equal(isAdminEmail("btpitch27@gmail.co"), false);
  assert.equal(isAdminEmail(""), false);
  assert.equal(isAdminEmail(null), false);
  assert.equal(isAdminEmail(undefined), false);
});

test("with no database the answer is NO, not yes", async () => {
  // ⚠️ FAIL CLOSED. This check gates writes that change the shop for every
  // player; an unreadable identity table must never be read as permission.
  clearAdminCache();
  assert.equal(await isAdmin("00000000-0000-0000-0000-000000000000"), false);
});

test("a non-admin's inventory is not the whole catalogue", async () => {
  // The derived-ownership path must be reachable only through isAdmin: with no
  // database, nobody is an admin and nobody owns anything.
  clearAdminCache();
  assert.deepEqual(await getInventory("00000000-0000-0000-0000-000000000000"), []);
});

test("an admin owns every paid item in the catalogue, in every kingdom", async () => {
  // ⚠️ DERIVED, NOT GRANTED — which is what makes "automatically" true of skins
  // that do not exist yet. Sixty inserted rows would cover today's catalogue
  // and quietly miss tomorrow's.
  const { adminInventory } = await import("../src/db/cosmetics.js");
  const { purchasable } = await import("../src/data/cosmetics.js");
  const { KINGDOM_IDS } = await import("../src/data/kingdoms.js");

  const owned = new Set(adminInventory());
  for (const item of purchasable()) {
    assert.ok(owned.has(item.id), `admin does not own ${item.id}`);
  }
  // Nothing default sneaks in: those are not inventory, they are the floor.
  const { cosmeticById } = await import("../src/data/cosmetics.js");
  for (const id of owned) assert.equal(cosmeticById(id)?.isDefault ?? false, false);

  // And every kingdom is represented, so no kingdom shows an admin a locked
  // wardrobe.
  for (const kingdomId of KINGDOM_IDS) {
    const has = purchasable().some(
      (item) => item.kingdomId === kingdomId && owned.has(item.id),
    );
    assert.ok(has, `admin owns nothing for ${kingdomId}`);
  }
});
