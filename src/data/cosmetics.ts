import { KINGDOM_IDS, type KingdomId } from "./kingdoms.js";

/**
 * The cosmetics catalogue.
 *
 * ⚠️ A SKIN IS A PARAMETER SET, NOT AN ASSET. `CastleSprite` is ~60 lines of
 * parametric SVG driven by a colour and an outline — there is no castle
 * artwork in this project. So a skin is a small object of paint values, which
 * is the only reason a catalogue this size is achievable at all: it is JSON,
 * not illustration.
 *
 * Rarity therefore describes real production effort rather than being an
 * arbitrary label, which is also why players will believe it:
 *
 *   common    palette      recolour                      (supported today)
 *   uncommon  palette+     recolour with an accent
 *   rare      material     gradients, stroke treatments
 *   legendary animated     banners, motion, particles
 *
 * Data only. `engine/store.ts` decides what is on sale; `db/cosmetics.ts`
 * decides who owns what.
 */

export type Rarity = "common" | "uncommon" | "rare" | "legendary";

/** Where a cosmetic is worn. Skins are per kingdom; nameplates are account-wide. */
export type CosmeticSlot = "castle" | "shield" | "nameplate";

/**
 * How a castle is painted.
 *
 * Every field is optional and falls back to the kingdom's own theme, so a
 * partial skin is a valid skin and an unknown field can be added later without
 * invalidating anything already owned.
 */
export interface Paint {
  /** Main fill. Defaults to the kingdom's primary. */
  fill?: string;
  /** Silhouette stroke. */
  outline?: string;
  /** Battlements, gate arch, and other detailing. */
  accent?: string;
  /** A two-stop gradient for the main fill; overrides `fill` when present. */
  gradient?: { from: string; to: string };
  /** Stroke width multiplier, for heavier or lighter silhouettes. */
  strokeScale?: number;
  /**
   * A decoration the client draws over the castle, named by id.
   *
   * ⚠️ AN ID, NEVER MARKUP. Coral, ice and a leviathan's fins are geometry and
   * motion, which is the client's job — the same split the game already uses
   * for abilities, where the server emits an event id and the client decides
   * what it looks like. Shipping SVG from the server would put rendering in the
   * simulation and make every skin a deployment of both halves.
   *
   * An id the client does not recognise draws nothing extra, so an older client
   * shows a plainer castle rather than a broken one.
   */
  decor?: string;
}

export interface CosmeticItem {
  id: string;
  slot: CosmeticSlot;
  /** The kingdom this belongs to; null for account-wide items. */
  kingdomId: KingdomId | null;
  name: string;
  rarity: Rarity;
  /** Coins. 0 for the defaults, which nobody buys. */
  price: number;
  /**
   * Always owned by everyone, never sold, and cannot be un-equipped to nothing.
   * Every kingdom needs exactly one.
   */
  isDefault?: boolean;
  /** Kingdom mastery required to buy it. Prestige items only. */
  requiresMastery?: string;
  paint?: Paint;
}

/** Prices by rarity. One table, so the catalogue cannot drift into ten prices. */
export const RARITY_PRICE: Record<Rarity, { castle: number; shield: number; nameplate: number }> = {
  common: { castle: 0, shield: 0, nameplate: 0 },
  uncommon: { castle: 600, shield: 500, nameplate: 400 },
  rare: { castle: 1_400, shield: 1_200, nameplate: 900 },
  legendary: { castle: 6_000, shield: 2_400, nameplate: 1_800 },
};

/**
 * Every kingdom's default castle skin.
 *
 * Generated rather than listed: sixteen identical entries differing only by id
 * is a table that will fall out of step with `KINGDOM_IDS` the first time a
 * kingdom is added. No paint at all — the absence IS the default, and the
 * renderer falls back to the kingdom's theme.
 */
const DEFAULT_CASTLES: CosmeticItem[] = KINGDOM_IDS.map((kingdomId) => ({
  id: `castle.${kingdomId}.default`,
  slot: "castle" as const,
  kingdomId,
  name: "Standard",
  rarity: "common" as const,
  price: 0,
  isDefault: true,
}));

const DEFAULT_SHIELDS: CosmeticItem[] = KINGDOM_IDS.map((kingdomId) => ({
  id: `shield.${kingdomId}.default`,
  slot: "shield" as const,
  kingdomId,
  name: "Standard",
  rarity: "common" as const,
  price: 0,
  isDefault: true,
}));

/**
 * The paid catalogue.
 *
 * Filled kingdom by kingdom. Everything around it already works: the store
 * rotation, purchase, inventory, equipping, the grid, the detail panel and the
 * per-kingdom wardrobe. Adding a kingdom is appending objects here — nothing
 * else changes, which is the point of having shipped the plumbing first.
 *
 * Geometry and motion live in the client, named by `paint.decor`. See
 * `Client/src/components/skins/` for what each id draws.
 *
 * The shape, for the first real entry to copy:
 *
 *   {
 *     id: "castle.fire.emberfall",
 *     slot: "castle",
 *     kingdomId: "fire",
 *     name: "Emberfall",
 *     rarity: "uncommon",
 *     price: RARITY_PRICE.uncommon.castle,
 *     paint: { fill: "#ff8a3d", accent: "#ffd08a", outline: "#3a1200" },
 *   }
 *
 * Per kingdom the rotation expects roughly: 2 uncommon, 2 rare (Daily shows
 * one, Featured draws from the other), and 1 legendary (Featured only).
 */
const PAID: CosmeticItem[] = [
  // --- Water ---------------------------------------------------------------
  {
    id: "castle.water.rippled",
    slot: "castle",
    kingdomId: "water",
    name: "Rippled Castle",
    rarity: "uncommon",
    price: RARITY_PRICE.uncommon.castle,
    paint: {
      fill: "#2f86c4",
      accent: "#7fd4ff",
      outline: "#08263f",
      decor: "water.ripples",
    },
  },
  {
    id: "castle.water.coral",
    slot: "castle",
    kingdomId: "water",
    name: "Coral Reef Fortress",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // A reef is lit from above: pale near the surface, deep at the base.
      gradient: { from: "#2f9c9a", to: "#14556b" },
      accent: "#7fe6d2",
      outline: "#062b33",
      decor: "water.coral",
    },
  },
  {
    id: "castle.water.frozen",
    slot: "castle",
    kingdomId: "water",
    name: "Frozen Harbor",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      gradient: { from: "#a9d8ef", to: "#2f6f9c" },
      accent: "#eaf7ff",
      outline: "#0a2d45",
      strokeScale: 1.1,
      decor: "water.frozen",
    },
  },
  {
    id: "castle.water.leviathan",
    slot: "castle",
    kingdomId: "water",
    name: "Leviathan Palace",
    rarity: "legendary",
    price: RARITY_PRICE.legendary.castle,
    paint: {
      // Deepest of the four: this one sits at the bottom of the ocean.
      gradient: { from: "#1b5f9e", to: "#06203c" },
      accent: "#7fd4ff",
      outline: "#03101f",
      strokeScale: 1.15,
      decor: "water.leviathan",
    },
  },
  {
    id: "castle.fire.embers",
    slot: "castle",
    kingdomId: "fire",
    name: "Ember Stripes",
    rarity: "uncommon",
    price: RARITY_PRICE.uncommon.castle,
    paint: {
      fill: "#d4482a",
      accent: "#ffb03a",
      outline: "#3a0c05",
      decor: "fire.embers",
    },
  },
  {
    id: "castle.fire.foundry",
    slot: "castle",
    kingdomId: "fire",
    name: "Inferno Foundry",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Warm-toned iron rather than neutral black: the darkest skin Fire has,
      // and it still has to read as Fire's from across the battlefield.
      gradient: { from: "#5a3a2a", to: "#1c100c" },
      accent: "#ff7a18",
      outline: "#0d0806",
      strokeScale: 1.1,
      decor: "fire.foundry",
    },
  },
  {
    id: "castle.fire.phoenix",
    slot: "castle",
    kingdomId: "fire",
    name: "Phoenix Fortress",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      gradient: { from: "#ff8a3d", to: "#a51e0c" },
      accent: "#ffd76a",
      outline: "#4a0d02",
      decor: "fire.phoenix",
    },
  },
  {
    id: "castle.fire.supernova",
    slot: "castle",
    kingdomId: "fire",
    name: "Supernova Citadel",
    rarity: "legendary",
    price: RARITY_PRICE.legendary.castle,
    paint: {
      // Lit from the star above it: bright at the parapet, falling to almost
      // black at the footing where the plasma takes over.
      gradient: { from: "#ffb03a", to: "#5c0f00" },
      accent: "#fff3d0",
      outline: "#2a0600",
      strokeScale: 1.15,
      decor: "fire.supernova",
    },
  },
  {
    id: "castle.air.windlines",
    slot: "castle",
    kingdomId: "air",
    name: "Wind Lines",
    rarity: "uncommon",
    price: RARITY_PRICE.uncommon.castle,
    paint: {
      fill: "#8fa9e0",
      accent: "#e8f0ff",
      outline: "#16233d",
      decor: "air.windlines",
    },
  },
  {
    id: "castle.air.skyship",
    slot: "castle",
    kingdomId: "air",
    name: "Skyship Fortress",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Lit from above, like anything that spends its life in open sky.
      gradient: { from: "#c8d6f5", to: "#5b7bb8" },
      accent: "#e8b964",
      outline: "#16233d",
      strokeScale: 1.05,
      decor: "air.skyship",
    },
  },
  {
    id: "castle.air.cloudpalace",
    slot: "castle",
    kingdomId: "air",
    name: "Cloud Palace",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Almost white at the parapet, where the cloud is thickest.
      gradient: { from: "#eef4ff", to: "#9dbbe4" },
      accent: "#ffffff",
      outline: "#2a3f68",
      decor: "air.cloudpalace",
    },
  },
  {
    id: "castle.air.stormtitan",
    slot: "castle",
    kingdomId: "air",
    name: "Storm Titan",
    rarity: "legendary",
    price: RARITY_PRICE.legendary.castle,
    paint: {
      // The darkest castle Air has: this one is inside the weather, not under it.
      gradient: { from: "#4a6499", to: "#101828" },
      accent: "#bfe4ff",
      outline: "#070c16",
      strokeScale: 1.15,
      decor: "air.stormtitan",
    },
  },
  {
    id: "castle.ice.frost",
    slot: "castle",
    kingdomId: "ice",
    name: "Frost Patterns",
    rarity: "uncommon",
    price: RARITY_PRICE.uncommon.castle,
    paint: {
      fill: "#7fd4ef",
      accent: "#eafaff",
      outline: "#0b2c45",
      decor: "ice.frost",
    },
  },
  {
    id: "castle.ice.palace",
    slot: "castle",
    kingdomId: "ice",
    name: "Ice Palace",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Lit from below by whatever is still burning inside it.
      gradient: { from: "#bdeeff", to: "#2f7fae" },
      accent: "#eafaff",
      outline: "#0b2c45",
      strokeScale: 1.05,
      decor: "ice.palace",
    },
  },
  {
    id: "castle.ice.glacier",
    slot: "castle",
    kingdomId: "ice",
    name: "Glacier Fortress",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      gradient: { from: "#9fd8ef", to: "#2b6d95" },
      accent: "#eafaff",
      outline: "#0a2438",
      strokeScale: 1.1,
      decor: "ice.glacier",
    },
  },
  {
    id: "castle.ice.crown",
    slot: "castle",
    kingdomId: "ice",
    name: "Frozen Crown",
    rarity: "legendary",
    price: RARITY_PRICE.legendary.castle,
    paint: {
      // Deep enough that the aurora and the shards read as the light sources.
      gradient: { from: "#7fc9e8", to: "#123a5c" },
      accent: "#eafaff",
      outline: "#06182a",
      strokeScale: 1.15,
      decor: "ice.crown",
    },
  },
  {
    id: "castle.electricity.circuit",
    slot: "castle",
    kingdomId: "electricity",
    name: "Circuit Castle",
    rarity: "uncommon",
    price: RARITY_PRICE.uncommon.castle,
    paint: {
      fill: "#4a2d7a",
      accent: "#ffe14a",
      outline: "#160826",
      decor: "electricity.circuit",
    },
  },
  {
    id: "castle.electricity.powerstation",
    slot: "castle",
    kingdomId: "electricity",
    name: "Power Station",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Cold and clean, deliberately unlike Fire's Foundry.
      gradient: { from: "#6b4a9e", to: "#241234" },
      accent: "#ffe14a",
      outline: "#140820",
      strokeScale: 1.1,
      decor: "electricity.powerstation",
    },
  },
  {
    id: "castle.electricity.tesla",
    slot: "castle",
    kingdomId: "electricity",
    name: "Tesla Tower",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      gradient: { from: "#7a55b0", to: "#2a1540" },
      accent: "#ffe14a",
      outline: "#150822",
      strokeScale: 1.1,
      decor: "electricity.tesla",
    },
  },
  {
    id: "castle.electricity.thundergod",
    slot: "castle",
    kingdomId: "electricity",
    name: "Thunder God Citadel",
    rarity: "legendary",
    price: RARITY_PRICE.legendary.castle,
    paint: {
      // Dark enough that the reactor and the rings are the light sources.
      gradient: { from: "#5e3d94", to: "#170a26" },
      accent: "#ffe14a",
      outline: "#0d0417",
      strokeScale: 1.15,
      decor: "electricity.thundergod",
    },
  },
  {
    id: "castle.nature.vine",
    slot: "castle",
    kingdomId: "nature",
    name: "Vine Castle",
    rarity: "uncommon",
    price: RARITY_PRICE.uncommon.castle,
    paint: {
      // Darker than Nature's own green so the vines climbing it can be seen.
      fill: "#39754c",
      accent: "#c9ffb0",
      outline: "#12301c",
      decor: "nature.vine",
    },
  },
  {
    id: "castle.nature.treehouse",
    slot: "castle",
    kingdomId: "nature",
    name: "Treehouse Kingdom",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Timber and moss rather than stone: this castle grew.
      gradient: { from: "#7fc98d", to: "#2c5c3c" },
      accent: "#ffe9a8",
      outline: "#10281a",
      strokeScale: 1.1,
      decor: "nature.treehouse",
    },
  },
  {
    id: "castle.nature.mushroom",
    slot: "castle",
    kingdomId: "nature",
    name: "Mushroom Fortress",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      gradient: { from: "#6fae7a", to: "#2b4f38" },
      accent: "#f0e7d2",
      outline: "#12281c",
      strokeScale: 1.05,
      decor: "nature.mushroom",
    },
  },
  {
    id: "castle.nature.worldtree",
    slot: "castle",
    kingdomId: "nature",
    name: "World Tree",
    rarity: "legendary",
    price: RARITY_PRICE.legendary.castle,
    paint: {
      // Dark, so the canopy and the lit roots are what the eye goes to.
      gradient: { from: "#4e8b5f", to: "#16301f" },
      accent: "#c8ffb0",
      outline: "#0a1c12",
      strokeScale: 1.15,
      decor: "nature.worldtree",
    },
  },
];

export const COSMETICS: CosmeticItem[] = [
  ...DEFAULT_CASTLES,
  ...DEFAULT_SHIELDS,
  ...PAID,
];

const BY_ID = new Map(COSMETICS.map((item) => [item.id, item]));

export function cosmeticById(id: string): CosmeticItem | undefined {
  return BY_ID.get(id);
}

/** The default item for a kingdom's slot — what an un-equipped seat wears. */
export function defaultCosmetic(
  slot: CosmeticSlot,
  kingdomId: KingdomId,
): CosmeticItem | undefined {
  return BY_ID.get(`${slot}.${kingdomId}.default`);
}

/** Everything buyable — excludes the defaults, which nobody purchases. */
export function purchasable(): CosmeticItem[] {
  return COSMETICS.filter((item) => !item.isDefault);
}
