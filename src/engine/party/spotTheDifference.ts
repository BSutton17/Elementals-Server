import { PARTY } from "../../data/balance.js";
import { COSMETICS } from "../../data/cosmetics.js";
import { param } from "../parameters.js";
import { botDifficulty, RETRY_SECONDS, successChance, ticksBetween } from "./bots.js";
import type { PartyActionResult, PartyGame, PartySession, PartySetup } from "./types.js";

/**
 * Spot the difference.
 *
 * Two copies of the same castle, one of them altered. Production stops until
 * the difference is found, and the table learns who was slowest.
 *
 * ⚠️ THE DIFFERENCE IS PLACED, NOT PAINTED OVER. The obvious implementation —
 * recolour the skin's accent, or drop its decor — cannot be scored: the server
 * has no idea WHERE on the castle the client draws any of that, so it cannot
 * decide whether a tap landed on the change. Instead both castles are drawn
 * with the same set of small ornaments at coordinates this side chose, and the
 * altered copy changes exactly one of them. The server knows precisely where
 * the difference is because it put it there, and a tap is scored against that
 * point with a generous radius — which is also what makes it playable with a
 * thumb.
 *
 * The base castle is a real rare or legendary skin, and never an animated one:
 * a moving ornament would make the change impossible to be sure of.
 */

export type DifferenceKind = "removed" | "recoloured";

export interface Ornament {
  /** Castle viewBox coordinates — the client draws in the same space. */
  x: number;
  y: number;
  r: number;
  colour: string;
}

export interface SpotSetup {
  /** The cosmetic id both castles are painted from. */
  cosmeticId: string;
  kingdomId: string;
  ornaments: Ornament[];
  /** Which ornament is different in the second castle. */
  changedIndex: number;
  kind: DifferenceKind;
  /** The replacement colour, when the change is a recolour. */
  newColour: string | null;
}

/**
 * Skins whose decor animates. Excluded as base images: a difference you have to
 * catch between two frames is not a difference, it is a reflex test.
 */
const ANIMATED_DECOR = new Set([
  "insects.charlottesweb",
  "kitsune.ninetail",
  "space.nexus",
  "time.eternal",
  "light.radiant",
  "love.cupid",
  "magma.worldvolcano",
  "water.leviathan",
  "nature.worldtree",
  "dark.voidfort",
  "joker.carnival",
  "electricity.thundergod",
  "air.stormtitan",
  "earth.colossus",
  "fire.phoenix",
  "ice.frozencrown",
]);

/** Rare and legendary castles that hold still. */
export function eligibleCastles(): { id: string; kingdomId: string }[] {
  return COSMETICS.filter(
    (item) =>
      item.slot === "castle" &&
      (item.rarity === "rare" || item.rarity === "legendary") &&
      !item.isDefault &&
      !ANIMATED_DECOR.has(item.paint?.decor ?? ""),
  ).map((item) => ({ id: item.id, kingdomId: item.kingdomId ?? "fire" }));
}

/** Somewhere on the castle body, spread out enough to be told apart. */
function placeOrnaments(rng: () => number, count: number): Ornament[] {
  const palette = ["#ffd76a", "#8fe0ff", "#ff8fa8", "#b6f5a8", "#e0d4ff", "#ffb27a"];
  const spots: Ornament[] = [];
  // The castle viewBox is '-92 -128 184 172'; this band sits over the walls and
  // keep, clear of the sky and the ground line.
  const columns = [-62, -34, -6, 22, 50];
  const rows = [-96, -66, -36];
  const cells: { x: number; y: number }[] = [];
  for (const y of rows) for (const x of columns) cells.push({ x, y });

  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
  }

  for (let i = 0; i < Math.min(count, cells.length); i++) {
    const cell = cells[i]!;
    spots.push({
      // Jittered off the grid so the set never reads as a lattice.
      x: cell.x + (rng() * 10 - 5),
      y: cell.y + (rng() * 8 - 4),
      r: 5 + rng() * 3,
      colour: palette[Math.floor(rng() * palette.length)]!,
    });
  }
  return spots;
}

export const SPOT_THE_DIFFERENCE_GAME: PartyGame = {
  id: "spotTheDifference",
  description: "Spot the Difference",
  timedSeconds: null,
  maxSeconds: PARTY.SPOT_MAX_SECONDS,
  stopsProduction: true,

  setup(match, players) {
    const castles = eligibleCastles();
    const castle = castles[Math.floor(match.rng() * castles.length)] ?? {
      id: "castle.water.coral",
      kingdomId: "water",
    };
    const ornaments = placeOrnaments(
      match.rng,
      param("party.spotOrnaments", PARTY.SPOT_ORNAMENTS),
    );
    const changedIndex = Math.floor(match.rng() * ornaments.length);
    const kind: DifferenceKind = match.rng() < 0.5 ? "removed" : "recoloured";
    const swatches = ["#ff5d5d", "#5dff9e", "#5db8ff", "#ffe45d", "#d45dff"];
    const current = ornaments[changedIndex]!.colour;
    const options = swatches.filter((c) => c !== current);

    const setup: SpotSetup = {
      cosmeticId: castle.id,
      kingdomId: castle.kingdomId,
      ornaments,
      changedIndex,
      kind,
      newColour:
        kind === "recoloured"
          ? options[Math.floor(match.rng() * options.length)]!
          : null,
    };

    const perPlayer: PartySetup["perPlayer"] = {};
    for (const player of players) perPlayer[player.id] = { misses: 0 };
    return { shared: { spot: setup as unknown as Record<string, unknown> }, perPlayer };
  },

  act(match, session, player, action): PartyActionResult {
    if (action.type !== "tap") return { ok: false, error: "Unknown action" };
    const me = session.players[player.id];
    if (!me || me.done) return { ok: false, error: "Already found it" };

    const x = typeof action.x === "number" ? action.x : NaN;
    const y = typeof action.y === "number" ? action.y : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "No point" };

    const setup = session.shared.spot as unknown as SpotSetup;
    const target = setup.ornaments[setup.changedIndex]!;
    const radius = param("party.spotTapRadius", PARTY.SPOT_TAP_RADIUS);
    const hit = Math.hypot(x - target.x, y - target.y) <= radius;

    if (!hit) {
      // Misses are counted but never punished: this is a race, and the clock is
      // already the punishment.
      me.data.misses = ((me.data.misses as number) ?? 0) + 1;
      return { ok: true };
    }

    me.done = true;
    me.outcome = "won";
    me.finishedTick = match.tick;
    return { ok: true };
  },

  bot(match, session, player) {
    const me = session.players[player.id];
    if (!me || me.done) return;
    // ⚠️ ROLLED REPEATEDLY, NOT ONCE. A player does not fail to spot the
    // difference — they keep looking. So does a bot: every few seconds it rolls
    // its chance again, which is what makes a weak bot SLOW rather than absent,
    // and slow is what this game punishes.
    if (me.data.botNextLookTick === undefined) {
      me.data.botNextLookTick =
        session.startedTick + ticksBetween(match.rng, ...RETRY_SECONDS.spot);
      return;
    }
    if (match.tick < (me.data.botNextLookTick as number)) return;
    me.data.botNextLookTick =
      match.tick + ticksBetween(match.rng, ...RETRY_SECONDS.spot);

    if (match.rng() >= successChance(botDifficulty(match, player.id))) return;
    me.done = true;
    me.outcome = "won";
    me.finishedTick = match.tick;
  },

  result(match, session) {
    // Named by kingdom, not by player: this is a game about kingdoms.
    const order = session.finishOrder;
    if (order.length < 2) return null;
    const lastId = order[order.length - 1]!;
    const player = match.gameState?.getPlayer(lastId);
    if (!player) return null;
    const kingdom = kingdomLabel(player.kingdomId);
    return `${kingdom} was the last one to spot the difference`;
  },
};

/** Title-cased kingdom name for a result line. */
export function kingdomLabel(kingdomId: string): string {
  return kingdomId.charAt(0).toUpperCase() + kingdomId.slice(1);
}

export function spotSetupOf(session: PartySession): SpotSetup {
  return session.shared.spot as unknown as SpotSetup;
}
