import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";
import {
  activateAbility,
  resolveAbility,
  type AbilityDefinition,
} from "../src/engine/abilities.js";
import { earn } from "../src/engine/money.js";
import { getStatus, processStatusTicks } from "../src/engine/status.js";
import {
  A_LIGHT_BREEZE,
  HURRICANE,
  THICK_FOG,
  BIRDS_EYE_VIEW,
  DUST_BUNNIES,
} from "../src/data/airAbilities.js";
import { FIREBALL } from "../src/data/fireAbilities.js";

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** Starts a match with one player per kingdom id given, in order (p0, p1, …). */
function skies(kingdoms: string[]): { match: Match; players: PlayerState[] } {
  const match = new Match("1234");
  kingdoms.forEach((k, i) => match.addPlayer(player(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const players = kingdoms.map((_, i) => gs.getPlayer(`p${i}`)!);
  for (const p of players) earn(p, 100_000);
  return { match, players };
}

/** A plain 1000-damage attack for driving deflection/redirect scenarios. */
const strike: AbilityDefinition = {
  id: "strike",
  kind: "attack",
  cost: 0,
  cooldownTicks: 0,
  targeting: { mode: "singleEnemy" },
  effects: [{ type: "damage", target: "target", params: { amount: 1000 } }],
};

// --- Embrace of Winds (multi-target attacks) ---------------------------------------

test("Embrace of Winds: Air attacks may hit multiple explicit targets for one cost/cooldown", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;

  const before = a.economy.currency;
  const r = activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1", "p2"],
    forceCrit: false,
  });
  assert.equal(r.ok, true);
  // Damage spreads evenly across the two kingdoms struck: 250 / 2 = 125 each.
  assert.equal(b.castle.hp, b.castle.maxHp - 125);
  assert.equal(c.castle.hp, c.castle.maxHp - 125);
  assert.equal(a.economy.currency, before - 100); // cost paid once
  assert.equal(a.cooldowns["aLightBreeze"], 60); // cooldown armed once
});

test("Embrace of Winds: a single target takes full damage (spread of 1)", () => {
  const { match, players } = skies(["air", "plains"]);
  const [a, b] = players;

  activateAbility(match, a, A_LIGHT_BREEZE, { targetIds: ["p1"], forceCrit: false });
  assert.equal(b.castle.hp, b.castle.maxHp - 250); // no spread with one target
});

test("Embrace of Winds: damage divides evenly and rounds across three targets", () => {
  const { match, players } = skies(["air", "plains", "water", "nature"]);
  const [a, b, c, d] = players;

  activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1", "p2", "p3"],
    forceCrit: false,
  });
  // 250 / 3 = 83.33… → resolveDamage rounds each hit to 83.
  assert.equal(b.castle.hp, b.castle.maxHp - 83);
  assert.equal(c.castle.hp, c.castle.maxHp - 83);
  assert.equal(d.castle.hp, d.castle.maxHp - 83);
});

test("Embrace of Winds: duplicate target ids collapse to one hit", () => {
  const { match, players } = skies(["air", "plains"]);
  const [a, b] = players;

  activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1", "p1"],
    forceCrit: false,
  });
  assert.equal(b.castle.hp, b.castle.maxHp - 250);
});

test("Embrace of Winds: an attack strikes at most maxTargets kingdoms (cap 3)", () => {
  const { match, players } = skies(["air", "plains", "water", "nature", "fire"]);
  const [, b, c, d, e] = players;

  // Five explicit ids, but the base cap is 3: only the first three resolve, and
  // the spread divides by the capped count (3), not the requested 5.
  activateAbility(match, players[0], A_LIGHT_BREEZE, {
    targetIds: ["p1", "p2", "p3", "p4"],
    forceCrit: false,
  });
  assert.equal(b.castle.hp, b.castle.maxHp - 83); // 250 / 3 -> 83
  assert.equal(c.castle.hp, c.castle.maxHp - 83);
  assert.equal(d.castle.hp, d.castle.maxHp - 83);
  assert.equal(e.castle.hp, e.castle.maxHp); // 4th target beyond the cap — untouched
});

test("Non-Air kingdoms cannot multi-target: only the first id is used", () => {
  const { match, players } = skies(["fire", "plains", "water"]);
  const [, b, c] = players;
  const f = players[0];

  activateAbility(match, f, FIREBALL, {
    targetIds: ["p1", "p2"],
    forceCrit: false,
  });
  assert.equal(b.castle.hp, b.castle.maxHp - 288); // 250 * 1.15 -> 288
  assert.equal(c.castle.hp, c.castle.maxHp); // untouched
});

// --- A Gust of Envy (5% incoming redirect) -----------------------------------------

test("A Gust of Envy: incoming attacks can be redirected — even back to the attacker", () => {
  const { match, players } = skies(["fire", "air", "plains"]);
  const [f, a] = players;

  // rng 0.0: redirect roll succeeds (0 < 0.05); destination index 0 of
  // [f, nature] (everyone alive except the Air target) -> the attacker.
  activateAbility(match, f, FIREBALL, {
    targetId: "p1",
    forceCrit: false,
    rng: () => 0.0,
  });
  assert.equal(a.castle.hp, a.castle.maxHp); // Air untouched
  assert.equal(f.castle.hp, f.castle.maxHp - 288); // attacker hit himself

  // rng 0.99: the 5% roll fails — the attack lands on Air normally.
  f.cooldowns = {};
  activateAbility(match, f, FIREBALL, {
    targetId: "p1",
    forceCrit: false,
    rng: () => 0.99,
  });
  assert.equal(a.castle.hp, a.castle.maxHp - 288);
});

// --- Hurricane (mark + guaranteed deflection) --------------------------------------

test("Hurricane damages and marks; the mark deflects the target's next attack on Air", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;

  // Air casts Hurricane on b: 450 damage + the until-used mark.
  const r = activateAbility(match, a, HURRICANE, { targetId: "p1", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 450);
  assert.ok(getStatus(b, "hurricaneMark"));

  // b attacks Air: deflected to a random other kingdom (rng 0 -> b himself).
  const hpBeforeStrike = b.castle.hp;
  activateAbility(match, b, strike, {
    targetId: "p0",
    forceCrit: false,
    rng: () => 0.0,
  });
  assert.equal(a.castle.hp, a.castle.maxHp); // Air never touched
  assert.equal(b.castle.hp, hpBeforeStrike - 1000); // deflected onto himself
  assert.equal(c.castle.hp, c.castle.maxHp);
  assert.ok(!getStatus(b, "hurricaneMark")); // consumed on use
});

test("Hurricane Lv3: the deflected attack deals increased damage to the redirected target", () => {
  const { match, players } = skies(["air", "plains"]);
  const [a, b] = players;
  a.upgrades["hurricane"] = 2; // Lv3: mark carries damageMult 1.25

  activateAbility(match, a, HURRICANE, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.hp, b.castle.maxHp - 550); // Lv2 damage upgrade included

  const hpBeforeStrike = b.castle.hp;
  activateAbility(match, b, strike, {
    targetId: "p0",
    forceCrit: false,
    rng: () => 0.0,
  });
  // 1000 * 1.25 (deflection amp) = 1250, onto himself (only destination).
  assert.equal(b.castle.hp, hpBeforeStrike - 1250);
  assert.equal(a.castle.hp, a.castle.maxHp);
});

test("Hurricane Lv5: a 50% roll allows one extra deflection — never a third", () => {
  const { match, players } = skies(["air", "plains"]);
  const [a, b] = players;
  a.upgrades["hurricane"] = 4; // Lv5: chainChance 0.5

  activateAbility(match, a, HURRICANE, { targetId: "p1", forceCrit: false });
  assert.ok(getStatus(b, "hurricaneMark"));

  // First deflection: chain roll succeeds (0 < 0.5) — the mark survives.
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.0 });
  assert.equal(a.castle.hp, a.castle.maxHp);
  assert.ok(getStatus(b, "hurricaneMark"));

  // Second deflection: already chained — always consumed now.
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.0 });
  assert.equal(a.castle.hp, a.castle.maxHp);
  assert.ok(!getStatus(b, "hurricaneMark"));
});

// --- Thick Fog (damage + screen obscure, capped) -----------------------------------

test("Thick Fog damages and fogs the target's screen", () => {
  const { match, players } = skies(["air", "plains"]);
  const [a, b] = players;

  const r = activateAbility(match, a, THICK_FOG, { targetId: "p1", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 350);
  const fog = getStatus(b, "vision:fog");
  assert.ok(fog);
  assert.equal(fog.remainingTicks, 100); // 5 s
});

test("Thick Fog is capped at 3 fogged players — a 4th cast is blocked, re-fogging is not", () => {
  const { match, players } = skies(["air", "plains", "plains", "plains", "plains"]);
  const a = players[0];

  for (const id of ["p1", "p2", "p3"]) {
    a.cooldowns = {};
    assert.equal(activateAbility(match, a, THICK_FOG, { targetId: id, forceCrit: false }).ok, true);
  }

  // 4th fresh target: blocked, nothing spent, no cooldown armed.
  a.cooldowns = {};
  const before = a.economy.currency;
  const blocked = activateAbility(match, a, THICK_FOG, { targetId: "p4", forceCrit: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "TARGET_LIMIT");
  assert.equal(a.economy.currency, before);
  assert.equal(a.cooldowns["thickFog"], undefined);

  // Re-fogging an already-fogged player stays legal at the cap.
  assert.equal(activateAbility(match, a, THICK_FOG, { targetId: "p1", forceCrit: false }).ok, true);

  // Lv5 raises the cap to 4: the blocked target is now foggable.
  a.upgrades["thickFog"] = 4;
  a.cooldowns = {};
  assert.equal(activateAbility(match, a, THICK_FOG, { targetId: "p4", forceCrit: false }).ok, true);
  assert.ok(getStatus(players[4], "vision:fog"));
});

// --- Bird's Eye View ----------------------------------------------------------------

test("Bird's Eye View applies the reveal marker to Air for its duration", () => {
  const { match, players } = skies(["air", "plains"]);
  const a = players[0];

  const r = activateAbility(match, a, BIRDS_EYE_VIEW);
  assert.equal(r.ok, true);
  const reveal = getStatus(a, "birdsEyeView");
  assert.ok(reveal);
  assert.equal(reveal.remainingTicks, 200); // 10 s

  // Lv2 extends the reveal; Lv3 shortens the cooldown.
  const lv2 = resolveAbility(BIRDS_EYE_VIEW, 1);
  assert.equal(lv2.effects[0].params.durationTicks, 300); // 15 s
  const lv3 = resolveAbility(BIRDS_EYE_VIEW, 2);
  assert.equal(lv3.cooldownTicks, 340); // 17 s
});

// --- Dust Bunnies -------------------------------------------------------------------

test("Dust Bunnies afflicts every opposing kingdom with damage over time", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;

  const r = activateAbility(match, a, DUST_BUNNIES);
  assert.equal(r.ok, true);
  assert.ok(getStatus(b, "dustBunnies"));
  assert.ok(getStatus(c, "dustBunnies"));
  assert.ok(!getStatus(a, "dustBunnies")); // never the caster

  b.castle.hp = 10_000;
  c.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 8);
  assert.equal(c.castle.hp, 10_000 - 8);
});

test("Dust Bunnies Lv2 increases the damage over time", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;
  a.upgrades["dustBunnies"] = 1;

  activateAbility(match, a, DUST_BUNNIES);
  b.castle.hp = 10_000;
  c.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 12);
  assert.equal(c.castle.hp, 10_000 - 12);
});

// --- Air Ability Upgrades ------------------------------------------------------------

test("A Light Breeze upgrades modify damage and cooldown values", () => {
  const lv1 = resolveAbility(A_LIGHT_BREEZE, 0);
  assert.equal(lv1.effects[0].params.amount, 250);
  assert.equal(lv1.cooldownTicks, 60);

  const lv2 = resolveAbility(A_LIGHT_BREEZE, 1);
  assert.equal(lv2.effects[0].params.amount, 300);

  const lv3 = resolveAbility(A_LIGHT_BREEZE, 2);
  assert.equal(lv3.cooldownTicks, 54);

  const lv4 = resolveAbility(A_LIGHT_BREEZE, 3);
  assert.equal(lv4.effects[0].params.amount, 350);
});

test("Hurricane and Thick Fog upgrades resolve their tier overrides", () => {
  // Hurricane: Lv2 damage, Lv3 deflect amp, Lv4 cooldown, Lv5 chain chance.
  const h2 = resolveAbility(HURRICANE, 1);
  assert.equal(h2.effects[0].params.amount, 550);
  const h3 = resolveAbility(HURRICANE, 2);
  assert.equal(h3.effects[1].params.status?.deflectsAttackOnSource?.damageMult, 1.25);
  const h4 = resolveAbility(HURRICANE, 3);
  assert.equal(h4.cooldownTicks, 180); // 9 s
  const h5 = resolveAbility(HURRICANE, 4);
  assert.equal(h5.effects[1].params.status?.deflectsAttackOnSource?.chainChance, 0.5);

  // Thick Fog: Lv2 damage, Lv3 fog duration, Lv4 cooldown, Lv5 cap 3 -> 4.
  const f2 = resolveAbility(THICK_FOG, 1);
  assert.equal(f2.effects[0].params.amount, 450);
  const f3 = resolveAbility(THICK_FOG, 2);
  assert.equal(f3.effects[1].params.vision?.durationTicks, 160); // 8 s
  const f4 = resolveAbility(THICK_FOG, 3);
  assert.equal(f4.cooldownTicks, 270); // 13.5 s
  const f5 = resolveAbility(THICK_FOG, 4);
  assert.equal(f5.maxConcurrentAffected?.limit, 4);
});
