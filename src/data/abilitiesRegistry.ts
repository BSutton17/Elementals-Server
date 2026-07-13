import { WATER_BALL, WATERFALL, FLOOD, FLUID_ASSIMILATION, RIPTIDE } from "./waterAbilities.js";
import { FIREBALL, SCORCHING_SUN, FIRENADO, HEAT_WAVE, BLAZING_DETERMINATION } from "./fireAbilities.js";
import { A_LIGHT_BREEZE, HURRICANE, THICK_FOG, BIRDS_EYE_VIEW, DUST_BUNNIES } from "./airAbilities.js";
import { ROCK_THROW, METEOR_SHOWER, EARTHQUAKE, NATURAL_TERRAIN, BRICK_WALL } from "./earthAbilities.js";
import { ZAP, LIGHTNING_BARRAGE, THUNDERDOME, HACK, THUNDERING_FATE } from "./electricityAbilities.js";
import { ICICLE, FLOOD_OF_FROST, FREEZE_TO_THE_CORE, SNOWMAN, BLIZZARD } from "./iceAbilities.js";
import { SLUDGE, ACID_RAIN, GASTRO_ACID, POISON_APPLE, TOXIC_GAS } from "./natureAbilities.js";
import type { AbilityDefinition } from "../engine/abilities.js";

export const ALL_ABILITIES: Record<string, AbilityDefinition> = {
  waterBall: WATER_BALL,
  waterfall: WATERFALL,
  flood: FLOOD,
  fluidAssimilation: FLUID_ASSIMILATION,
  riptide: RIPTIDE,
  fireball: FIREBALL,
  scorchingSun: SCORCHING_SUN,
  firenado: FIRENADO,
  heatWave: HEAT_WAVE,
  blazingDetermination: BLAZING_DETERMINATION,
  aLightBreeze: A_LIGHT_BREEZE,
  hurricane: HURRICANE,
  thickFog: THICK_FOG,
  birdsEyeView: BIRDS_EYE_VIEW,
  dustBunnies: DUST_BUNNIES,
  rockThrow: ROCK_THROW,
  meteorShower: METEOR_SHOWER,
  earthquake: EARTHQUAKE,
  naturalTerrain: NATURAL_TERRAIN,
  brickWall: BRICK_WALL,
  zap: ZAP,
  lightningBarrage: LIGHTNING_BARRAGE,
  thunderdome: THUNDERDOME,
  hack: HACK,
  thunderingFate: THUNDERING_FATE, // key = ability id (cooldownModify looks ids up here)
  icicle: ICICLE,
  floodOfFrost: FLOOD_OF_FROST,
  freezeToTheCore: FREEZE_TO_THE_CORE,
  snowman: SNOWMAN,
  blizzard: BLIZZARD,
  sludge: SLUDGE,
  acidRain: ACID_RAIN,
  gastroAcid: GASTRO_ACID,
  poisonApple: POISON_APPLE,
  toxicGas: TOXIC_GAS,
};
