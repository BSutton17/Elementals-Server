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
  /**
   * Marks a skin whose appearance is rolled per match. The server fills in
   * `variantSeed` below; the client decides what the seed means.
   */
  varies?: boolean;
  /**
   * A stable number for one castle in one match, derived from the room code
   * and the player id.
   *
   * ⚠️ THE SERVER HAS TO PICK THIS, NOT THE CLIENT. Seven people are looking at
   * the same castle, and a seed rolled locally would give each of them a
   * different one — the kind of desync nobody reports as a bug because every
   * player's screen looks internally consistent. Deriving it from ids the
   * server already has costs nothing and needs no storage, the same way levels
   * and quests are derived rather than stored.
   */
  variantSeed?: number;
  /**
   * Shrinks the castle body, anchored at its footing, so a decoration can
   * dwarf it. Cosmetic only, and used by exactly one skin — see the warning in
   * the client's CastleSprite before reaching for it again.
   */
  scale?: number
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
    name: "Burning Citadel",
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
    name: "Thunder God",
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
    name: "Rose's Treehouse",
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
    name: "Tree of Life",
    rarity: "legendary",
    price: RARITY_PRICE.legendary.castle,
    paint: {
      // Dark, so the canopy and the lit roots are what the eye goes to.
      // Brighter than the rest of Nature on purpose: at this size, against
      // dark bark, a dim castle is an invisible castle.
      gradient: { from: "#a5f0bc", to: "#3f8a5c" },
      accent: "#eaffd8",
      outline: "#0a1c12",
      strokeScale: 1.15,
      // The tree is the subject; the fortress is the thing it dwarfs.
      scale: 0.62,
      decor: "nature.worldtree",
    },
  },
  {
    id: "castle.time.clockwork",
    slot: "castle",
    kingdomId: "time",
    name: "Clockwork",
    rarity: "uncommon",
    price: RARITY_PRICE.uncommon.castle,
    paint: {
      fill: "#7a5a33",
      accent: "#d9c39a",
      outline: "#221507",
      decor: "time.clockwork",
    },
  },
  {
    id: "castle.time.chrono",
    slot: "castle",
    kingdomId: "time",
    name: "Chrono Tower",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Mid-tone: the two ages painted over it have to be the thing you see,
      // and both a pale stone and a lit panel need somewhere to sit.
      gradient: { from: "#9c7a4c", to: "#3d2b1a" },
      accent: "#d9c39a",
      outline: "#221507",
      strokeScale: 1.05,
      decor: "time.chrono",
    },
  },
  {
    id: "castle.time.rift",
    slot: "castle",
    kingdomId: "time",
    name: "Time Rift Fortress",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Mid-tone: three eras are painted over this and all of them need
      // somewhere to sit.
      gradient: { from: "#9c7a4c", to: "#43301c" },
      accent: "#d9c39a",
      outline: "#221507",
      strokeScale: 1.05,
      // Three eras out of six, rolled per match. See Paint.varies.
      varies: true,
      decor: "time.rift",
    },
  },
  {
    id: "castle.time.eternal",
    slot: "castle",
    kingdomId: "time",
    name: "Eternal Citadel",
    rarity: "legendary",
    price: RARITY_PRICE.legendary.castle,
    paint: {
      // Dark, so the gold movement around it is what the eye goes to.
      gradient: { from: "#a98a4e", to: "#2a1c0c" },
      accent: "#f0c94a",
      outline: "#160d03",
      strokeScale: 1.15,
      decor: "time.eternal",
    },
  },
  {
    id: "castle.space.starpattern",
    slot: "castle",
    kingdomId: "space",
    name: "Star Pattern Castle",
    rarity: "uncommon",
    price: RARITY_PRICE.uncommon.castle,
    paint: {
      fill: "#3b2470",
      accent: "#8fb8ff",
      outline: "#080418",
      decor: "space.starpattern",
    },
  },
  {
    id: "castle.space.spaceship",
    slot: "castle",
    kingdomId: "space",
    name: "Spaceship Fortress",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Hull grey-violet: Space absorbs where Electricity glows, and the two
      // must not be mistaken for each other at 60% scale.
      gradient: { from: "#4a4180", to: "#140d2c" },
      accent: "#7fe3ff",
      outline: "#080418",
      strokeScale: 1.1,
      decor: "space.spaceship",
    },
  },
  {
    id: "castle.space.alienbase",
    slot: "castle",
    kingdomId: "space",
    name: "Alien Planet Base",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Wrong-colour rock: this fortress was not built from anything on Earth.
      gradient: { from: "#7a4a9e", to: "#2a1440" },
      accent: "#7ff0a8",
      outline: "#080418",
      strokeScale: 1.05,
      decor: "space.alienbase",
    },
  },
  {
    id: "castle.space.nexus",
    slot: "castle",
    kingdomId: "space",
    name: "Cosmic Nexus",
    rarity: "legendary",
    price: RARITY_PRICE.legendary.castle,
    paint: {
      // Dark walls with a core behind them: the light has to look like it is
      // coming OUT of the fortress, not falling on it.
      gradient: { from: "#4b3a8e", to: "#0d0722" },
      accent: "#fff4d0",
      outline: "#060312",
      strokeScale: 1.15,
      decor: "space.nexus",
    },
  },
  {
    id: "castle.light.radiant",
    slot: "castle",
    kingdomId: "light",
    name: "Radiant Lines",
    rarity: "uncommon",
    price: RARITY_PRICE.uncommon.castle,
    paint: {
      // Warm white rather than Light's flat #f7f7f2: the gold channels need a
      // stone that is on the same side of the colour wheel to sit against, or
      // they read as yellow scribble on paper.
      gradient: { from: "#fffdf5", to: "#e4dcc4" },
      accent: "#e3b03c",
      outline: "#5c4413",
      decor: "light.radiant",
    },
  },
  {
    id: "castle.light.solartemple",
    slot: "castle",
    kingdomId: "light",
    name: "Solar Temple",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Marble. The sun behind it is the brightest thing on the sprite, so the
      // temple itself sits a step down from white or the disc has nothing to
      // out-shine.
      gradient: { from: "#fdfbf2", to: "#d5cdb6" },
      accent: "#e3b03c",
      outline: "#5c4413",
      strokeScale: 1.05,
      decor: "light.solartemple",
    },
  },
  {
    id: "castle.light.cathedral",
    slot: "castle",
    kingdomId: "light",
    name: "Crystal Cathedral",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Cool enough to read as crystal, warm enough not to be Ice: the stained
      // glass carries the colour here, so the body stays close to white.
      gradient: { from: "#ffffff", to: "#ccc6b6" },
      accent: "#e3b03c",
      outline: "#4a4436",
      strokeScale: 1.05,
      decor: "light.cathedral",
    },
  },
  {
    id: "castle.light.celestial",
    slot: "castle",
    kingdomId: "light",
    name: "Celestial Palace",
    rarity: "legendary",
    price: RARITY_PRICE.legendary.castle,
    paint: {
      // Gold, not white. The wings and the halos behind it are the pale things
      // here, so the palace has to be the warmer one or it disappears into its
      // own light.
      gradient: { from: "#fff6dc", to: "#cf9a2c" },
      accent: "#fffdf5",
      outline: "#5c4413",
      strokeScale: 1.15,
      decor: "light.celestial",
    },
  },
  {
    id: "castle.earth.stonelines",
    slot: "castle",
    kingdomId: "earth",
    name: "Stone Lines",
    rarity: "uncommon",
    price: RARITY_PRICE.uncommon.castle,
    paint: {
      // Sandstone, a shade deeper than the kingdom's own so the cut courses
      // have something to be lighter than.
      gradient: { from: "#d8b87d", to: "#9c7740" },
      accent: "#e6cfa0",
      outline: "#33240f",
      decor: "earth.stonelines",
    },
  },
  {
    id: "castle.earth.temple",
    slot: "castle",
    kingdomId: "earth",
    name: "Ancient Temple",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Lighter than the mountain behind it. The rock is the dark mass here,
      // and the temple has to read as cut out of it rather than lost in it.
      gradient: { from: "#e0c28c", to: "#a8834b" },
      accent: "#f0dcb4",
      outline: "#33240f",
      strokeScale: 1.1,
      decor: "earth.temple",
    },
  },
  {
    id: "castle.earth.cavern",
    slot: "castle",
    kingdomId: "earth",
    name: "Crystal Cavern",
    rarity: "rare",
    price: RARITY_PRICE.rare.castle,
    paint: {
      // Underground stone: darker than the other two Earth skins, because down
      // here the crystal is the only light source and it needs somewhere dim to
      // be bright against.
      gradient: { from: "#a98a55", to: "#5c451f" },
      accent: "#e2d0ff",
      outline: "#241a0c",
      strokeScale: 1.05,
      decor: "earth.cavern",
    },
  },
  {
    id: "castle.earth.colossus",
    slot: "castle",
    kingdomId: "earth",
    name: "Mount Colossus",
    rarity: "legendary",
    price: RARITY_PRICE.legendary.castle,
    paint: {
      // The castle is the titan's chest, so it is the same rock as the rest of
      // it — one shade lighter, which is all that separates the fortress from
      // the body it belongs to.
      gradient: { from: "#a8875a", to: "#584223" },
      accent: "#d9c39a",
      outline: "#241a0c",
      strokeScale: 1.15,
      decor: "earth.colossus",
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
/**
 * Which castle skin a bot wears, or undefined for the kingdom's default.
 *
 * A bot only dresses up if its kingdom has a FULL set — at least one uncommon,
 * two rares and one legendary. Kingdoms are being filled in one at a time, and
 * a half-finished one would otherwise show its single skin on most of its bots,
 * which reads as "every bot owns the same thing" rather than as variety.
 *
 * The odds: 25% default, 25% uncommon, 40% rare, 10% legendary — and within a
 * tier the chance is split evenly, so two rares are 20% each.
 *
 * ⚠️ THE CALLER MUST PASS A SEED THAT IS THE SAME ON EVERY CLIENT. This is
 * called while building the snapshot each player receives, so a `Math.random()`
 * here would give seven people seven different bots. See `paintFor`.
 */
/**
 * Murmur3's finalizer. Not a hash of anything — it takes one number and stirs
 * it until neighbouring inputs give unrelated outputs, which is what makes
 * `% 100` on the result actually uniform.
 */
function mix32(n: number): number {
  let h = n >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function botCastleFor(
  kingdomId: string,
  seed: number,
): CosmeticItem | undefined {
  const byRarity = (r: Rarity) =>
    PAID.filter(
      (c) => c.slot === "castle" && c.kingdomId === kingdomId && c.rarity === r,
    );
  const uncommon = byRarity("uncommon");
  const rare = byRarity("rare");
  const legendary = byRarity("legendary");
  if (uncommon.length < 1 || rare.length < 2 || legendary.length < 1) return undefined;

  // Two independent draws off the one seed: the tier, then which skin in it.
  // Reusing the same number for both would tie the choice of skin to the tier
  // it landed in, and the rare pool would only ever show its first entry.
  //
  // ⚠️ A LINEAR CONGRUENTIAL STEP IS NOT ENOUGH HERE. The first version used
  // one, and over a run of nearby seeds the rare tier came out at 42% instead
  // of 40 — an LCG barely changes the high bits between consecutive inputs, so
  // taking it mod 100 inherits the input's own pattern. Real seeds are FNV
  // hashes of ids and would probably have masked it, which is exactly why it
  // is worth not relying on: a distribution that is only correct for
  // well-distributed inputs will drift the moment someone feeds it something
  // else. `mix32` avalanches, so every bit of the output depends on every bit
  // of the input.
  const tierRoll = mix32(seed) % 100;
  const pickRoll = mix32(seed ^ 0x5bf03635);

  const pick = (pool: CosmeticItem[]) => pool[pickRoll % pool.length];
  if (tierRoll < 25) return undefined; // default
  if (tierRoll < 50) return pick(uncommon);
  if (tierRoll < 90) return pick(rare);
  return pick(legendary);
}

export function purchasable(): CosmeticItem[] {
  return COSMETICS.filter((item) => !item.isDefault);
}
