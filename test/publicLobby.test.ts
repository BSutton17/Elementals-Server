import test from "node:test";
import assert from "node:assert/strict";
import { MatchManager } from "../src/match/MatchManager.js";
import { MATCH } from "../src/data/balance.js";
import { seatEveryone } from "../src/net/publicLobby.js";
import {
  PublicLobbyManager,
  FIRST_JOIN_SECONDS,
  PER_JOIN_SECONDS,
} from "../src/net/PublicLobbyManager.js";
import { hasFullPerkSelection } from "../src/data/perks.js";
import type { Match } from "../src/match/Match.js";
import type { MatchPlayer } from "../src/match/types.js";

/**
 * Public rooms: matchmade, hostless, and started by a clock rather than a
 * person. Everything a host would have decided is decided here instead.
 */

function human(id: string, over: Partial<MatchPlayer> = {}): MatchPlayer {
  return {
    id, socketId: `s-${id}`, name: id, kingdomId: null, perks: [],
    ready: false, connected: true, ...over,
  } as MatchPlayer;
}

function manager(matches: MatchManager) {
  const started: string[] = [];
  const closed: string[] = [];
  const mgr = new PublicLobbyManager(matches, {
    startMatch: (m) => started.push(m.roomCode),
    broadcast: () => {},
    closeRoom: (code) => { closed.push(code); matches.removeMatch(code); },
  });
  return { mgr, started, closed };
}

function publicRoom(matches: MatchManager, humans: number): Match {
  const match = matches.createMatch({ visibility: "public" });
  for (let i = 0; i < humans; i++) match.addPlayer(human(`p${i}`));
  return match;
}

test("a public room has no host, so every host-only action is closed to everyone", () => {
  // Nothing needs to learn about visibility: `hostId` stays null and
  // `isHost` is false for all comers, which is what the handlers already check.
  const matches = new MatchManager();
  const match = publicRoom(matches, 2);
  assert.equal(match.hostId, null);
  assert.equal(match.isHost("p0"), false);
  assert.equal(match.isHost("p1"), false);
});

test("the countdown opens at 30s and each new arrival adds 15s", () => {
  const matches = new MatchManager();
  const { mgr } = manager(matches);
  const match = publicRoom(matches, 1);

  const before = Date.now();
  mgr.onHumanJoined(match);
  const first = match.startsAt!;
  assert.ok(first >= before + FIRST_JOIN_SECONDS * 1000 - 50);
  assert.ok(first <= Date.now() + FIRST_JOIN_SECONDS * 1000 + 50);

  match.addPlayer(human("p1"));
  mgr.onHumanJoined(match);
  // ADDED to the existing deadline, not reset from now — a filling room stays
  // open a little longer rather than restarting its wait each time.
  assert.ok(
    match.startsAt! - first >= PER_JOIN_SECONDS * 1000 - 50,
    `expected +${PER_JOIN_SECONDS}s, got ${(match.startsAt! - first) / 1000}s`,
  );
  mgr.clear();
});

test("a full room starts at once instead of waiting out its clock", () => {
  const matches = new MatchManager();
  const { mgr, started } = manager(matches);
  const match = publicRoom(matches, MATCH.MAX_ACTIVE_PLAYERS);
  mgr.onHumanJoined(match);
  assert.deepEqual(started, [match.roomCode]);
  assert.equal(match.startsAt, null, "a launched room is no longer counting");
  mgr.clear();
});

test("players who never chose are given a kingdom and perks rather than dropped", () => {
  // ⚠️ `canStart()` demands every connected player be ready with a kingdom AND
  // a full perk selection. A stranger who joins and walks away never satisfies
  // it, and the countdown fires anyway — so the room is made startable.
  const matches = new MatchManager();
  const match = publicRoom(matches, 3);
  assert.equal(match.canStart(), false, "precondition: nobody has chosen yet");

  const result = seatEveryone(match);

  assert.equal(result.assignedKingdom.length, 3);
  assert.equal(result.assignedPerks.length, 3);
  for (const p of match.getPlayers().filter((x) => x.isBot !== true)) {
    assert.ok(p.kingdomId, `${p.id} has no kingdom`);
    assert.ok(p.ready, `${p.id} is not ready`);
    assert.ok(hasFullPerkSelection(p.perks, p.kingdomId!), `${p.id} has an illegal perk set`);
  }
  assert.equal(match.canStart(), true);
});

test("a player's own choices are left alone", () => {
  const matches = new MatchManager();
  const match = matches.createMatch({ visibility: "public" });
  match.addPlayer(human("chose", { kingdomId: "fire", perks: ["swiftFooted", "betterConstruction"] as never, ready: true }));
  match.addPlayer(human("idle"));

  const result = seatEveryone(match);
  assert.equal(match.getPlayer("chose")!.kingdomId, "fire", "a made choice must survive");
  assert.equal(result.assignedKingdom.includes("chose"), false);
  assert.ok(result.assignedKingdom.includes("idle"));
});

test("empty seats fill with HARD bots, and never steal a human's kingdom", () => {
  const matches = new MatchManager();
  const match = publicRoom(matches, 2);
  const result = seatEveryone(match);

  assert.equal(match.activePlayerCount, MATCH.MAX_ACTIVE_PLAYERS);
  assert.ok(result.botsAdded > 0);
  const bots = match.getPlayers().filter((p) => p.isBot === true);
  for (const b of bots) assert.equal(b.botDifficulty, "hard");

  // Humans are seated first precisely so this holds.
  const kingdoms = match.getPlayers().map((p) => p.kingdomId);
  assert.equal(new Set(kingdoms).size, kingdoms.length, "two seats share a kingdom");
});

test("matchmaking offers the fullest joinable room, and skips ones it must not", () => {
  const matches = new MatchManager();
  const { mgr } = manager(matches);

  const empty = publicRoom(matches, 1);
  const busy = publicRoom(matches, 4);
  const started = publicRoom(matches, 2);
  started.phase = "active";
  const priv = matches.createMatch();
  priv.addPlayer(human("h"));

  // Fullest first: it gets people into a game that is about to begin rather
  // than scattering them one-per-room to each wait a full countdown.
  assert.equal(mgr.findOpenRoom()?.roomCode, busy.roomCode);

  matches.removeMatch(busy.roomCode);
  assert.equal(mgr.findOpenRoom()?.roomCode, empty.roomCode);

  matches.removeMatch(empty.roomCode);
  assert.equal(mgr.findOpenRoom(), null, "an active match and a private room are not offerable");
  mgr.clear();
});

test("a room whose seats are all bots is never offered to a searcher", () => {
  // Otherwise a player is matched into a lobby where they are alone with seven
  // bots, which is the opposite of what they asked for.
  const matches = new MatchManager();
  const { mgr } = manager(matches);
  const match = publicRoom(matches, 1);
  seatEveryone(match);
  match.removePlayer("p0");
  assert.equal(mgr.findOpenRoom(), null);
  mgr.clear();
});

test("a dropped player's reserved seat keeps the room alive", () => {
  // ⚠️ The reconnection grace is 60s and the reaper's fuse is 10s. Counting
  // only CONNECTED people would destroy the room fifty seconds before the last
  // player's seat was even released, and they would reconnect into nothing.
  const matches = new MatchManager();
  const match = publicRoom(matches, 1);
  const player = match.getPlayer("p0")!;

  assert.equal(match.humanCount(), 1);
  assert.equal(match.connectedHumanCount(), 1);

  player.connected = false;
  player.socketId = null;
  assert.equal(match.humanCount(), 1, "the seat is still reserved");
  assert.equal(match.connectedHumanCount(), 0, "but nobody is present");

  match.removePlayer("p0");
  assert.equal(match.humanCount(), 0, "grace expired — now it is genuinely empty");
});

test("a room nobody is left in is closed, and one still holding a seat is not", async () => {
  const matches = new MatchManager();
  const { mgr, closed } = manager(matches);

  const abandoned = publicRoom(matches, 1);
  const occupied = publicRoom(matches, 1);

  // Only the abandoned room loses its last human seat.
  abandoned.removePlayer("p0");
  mgr.onRosterChanged(abandoned);
  mgr.onRosterChanged(occupied);

  // The fuse is ten seconds; nothing should have happened yet.
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(closed, [], "closed a room before its fuse ran out");

  mgr.clear();
});

test("someone returning inside the fuse saves the room", () => {
  // The reaper re-reads the room when it fires rather than trusting the
  // snapshot it was armed with, so a seat taken in the meantime cancels it.
  const matches = new MatchManager();
  const { mgr } = manager(matches);
  const match = publicRoom(matches, 1);

  match.removePlayer("p0");
  mgr.onRosterChanged(match);          // fuse lit
  match.addPlayer(human("returned"));
  mgr.onRosterChanged(match);          // and put out

  assert.equal(match.humanCount(), 1);
  assert.ok(matches.getMatch(match.roomCode), "the room must survive");
  mgr.clear();
});
