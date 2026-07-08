/**
 * Java → Bedrock vanilla texture path mapping.
 *
 * Strategy:
 *  1. Directory-level remap (block→blocks, item→items, …).
 *  2. Explicit filename rename tables for textures whose names differ
 *     (Bedrock kept many pre-flattening 1.12 names).
 *  3. Anything not in the rename tables passes through with the same filename —
 *     correct for most 1.13+ content where Bedrock adopted parity names.
 *
 * Composite textures (paintings atlas, particles atlas, chest stitching,
 * clock/compass atlases) are handled by dedicated stages, not this table.
 */

/** Java block texture name → Bedrock block texture name (both without extension). */
export const BLOCK_RENAMES: Record<string, string> = {
  // grass / dirt / paths
  grass_block_top: "grass_top",
  grass_block_side: "grass_side_carried",
  grass_block_side_overlay: "grass_side",
  grass_block_snow: "grass_side_snowed",
  dirt_path_top: "grass_path_top",
  dirt_path_side: "grass_path_side",
  podzol_top: "dirt_podzol_top",
  podzol_side: "dirt_podzol_side",
  farmland: "farmland_dry",
  farmland_moist: "farmland_wet",
  coarse_dirt: "coarse_dirt",
  // logs / wood
  oak_log: "log_oak",
  oak_log_top: "log_oak_top",
  spruce_log: "log_spruce",
  spruce_log_top: "log_spruce_top",
  birch_log: "log_birch",
  birch_log_top: "log_birch_top",
  jungle_log: "log_jungle",
  jungle_log_top: "log_jungle_top",
  acacia_log: "log_acacia",
  acacia_log_top: "log_acacia_top",
  dark_oak_log: "log_big_oak",
  dark_oak_log_top: "log_big_oak_top",
  oak_planks: "planks_oak",
  spruce_planks: "planks_spruce",
  birch_planks: "planks_birch",
  jungle_planks: "planks_jungle",
  acacia_planks: "planks_acacia",
  dark_oak_planks: "planks_big_oak",
  // leaves / saplings
  oak_leaves: "leaves_oak",
  spruce_leaves: "leaves_spruce",
  birch_leaves: "leaves_birch",
  jungle_leaves: "leaves_jungle",
  acacia_leaves: "leaves_acacia",
  dark_oak_leaves: "leaves_big_oak",
  oak_sapling: "sapling_oak",
  spruce_sapling: "sapling_spruce",
  birch_sapling: "sapling_birch",
  jungle_sapling: "sapling_jungle",
  acacia_sapling: "sapling_acacia",
  dark_oak_sapling: "sapling_big_oak",
  // stone family
  granite: "stone_granite",
  polished_granite: "stone_granite_smooth",
  diorite: "stone_diorite",
  polished_diorite: "stone_diorite_smooth",
  andesite: "stone_andesite",
  polished_andesite: "stone_andesite_smooth",
  stone_bricks: "stonebrick",
  mossy_stone_bricks: "stonebrick_mossy",
  cracked_stone_bricks: "stonebrick_cracked",
  chiseled_stone_bricks: "stonebrick_carved",
  mossy_cobblestone: "cobblestone_mossy",
  smooth_stone: "stone_slab_top",
  smooth_stone_slab_side: "stone_slab_side",
  bricks: "brick",
  // sandstone
  sandstone: "sandstone_normal",
  sandstone_top: "sandstone_top",
  sandstone_bottom: "sandstone_bottom",
  chiseled_sandstone: "sandstone_carved",
  cut_sandstone: "sandstone_smooth",
  red_sandstone: "red_sandstone_normal",
  chiseled_red_sandstone: "red_sandstone_carved",
  cut_red_sandstone: "red_sandstone_smooth",
  // nether / end
  nether_bricks: "nether_brick",
  red_nether_bricks: "red_nether_brick",
  nether_quartz_ore: "quartz_ore",
  chiseled_quartz_block: "quartz_block_chiseled",
  chiseled_quartz_block_top: "quartz_block_chiseled_top",
  quartz_pillar: "quartz_block_lines",
  quartz_pillar_top: "quartz_block_lines_top",
  end_stone_bricks: "end_bricks",
  // misc full blocks
  packed_ice: "ice_packed",
  wet_sponge: "sponge_wet",
  prismarine: "prismarine_rough",
  dark_prismarine: "prismarine_dark",
  slime_block: "slime",
  note_block: "noteblock",
  terracotta: "hardened_clay",
  // colored blocks — wool
  white_wool: "wool_colored_white",
  orange_wool: "wool_colored_orange",
  magenta_wool: "wool_colored_magenta",
  light_blue_wool: "wool_colored_light_blue",
  yellow_wool: "wool_colored_yellow",
  lime_wool: "wool_colored_lime",
  pink_wool: "wool_colored_pink",
  gray_wool: "wool_colored_gray",
  light_gray_wool: "wool_colored_silver",
  cyan_wool: "wool_colored_cyan",
  purple_wool: "wool_colored_purple",
  blue_wool: "wool_colored_blue",
  brown_wool: "wool_colored_brown",
  green_wool: "wool_colored_green",
  red_wool: "wool_colored_red",
  black_wool: "wool_colored_black",
  // terracotta (stained clay)
  white_terracotta: "hardened_clay_stained_white",
  orange_terracotta: "hardened_clay_stained_orange",
  magenta_terracotta: "hardened_clay_stained_magenta",
  light_blue_terracotta: "hardened_clay_stained_light_blue",
  yellow_terracotta: "hardened_clay_stained_yellow",
  lime_terracotta: "hardened_clay_stained_lime",
  pink_terracotta: "hardened_clay_stained_pink",
  gray_terracotta: "hardened_clay_stained_gray",
  light_gray_terracotta: "hardened_clay_stained_silver",
  cyan_terracotta: "hardened_clay_stained_cyan",
  purple_terracotta: "hardened_clay_stained_purple",
  blue_terracotta: "hardened_clay_stained_blue",
  brown_terracotta: "hardened_clay_stained_brown",
  green_terracotta: "hardened_clay_stained_green",
  red_terracotta: "hardened_clay_stained_red",
  black_terracotta: "hardened_clay_stained_black",
  // glazed terracotta
  white_glazed_terracotta: "glazed_terracotta_white",
  orange_glazed_terracotta: "glazed_terracotta_orange",
  magenta_glazed_terracotta: "glazed_terracotta_magenta",
  light_blue_glazed_terracotta: "glazed_terracotta_light_blue",
  yellow_glazed_terracotta: "glazed_terracotta_yellow",
  lime_glazed_terracotta: "glazed_terracotta_lime",
  pink_glazed_terracotta: "glazed_terracotta_pink",
  gray_glazed_terracotta: "glazed_terracotta_gray",
  light_gray_glazed_terracotta: "glazed_terracotta_silver",
  cyan_glazed_terracotta: "glazed_terracotta_cyan",
  purple_glazed_terracotta: "glazed_terracotta_purple",
  blue_glazed_terracotta: "glazed_terracotta_blue",
  brown_glazed_terracotta: "glazed_terracotta_brown",
  green_glazed_terracotta: "glazed_terracotta_green",
  red_glazed_terracotta: "glazed_terracotta_red",
  black_glazed_terracotta: "glazed_terracotta_black",
  // stained glass
  white_stained_glass: "glass_white",
  orange_stained_glass: "glass_orange",
  magenta_stained_glass: "glass_magenta",
  light_blue_stained_glass: "glass_light_blue",
  yellow_stained_glass: "glass_yellow",
  lime_stained_glass: "glass_lime",
  pink_stained_glass: "glass_pink",
  gray_stained_glass: "glass_gray",
  light_gray_stained_glass: "glass_silver",
  cyan_stained_glass: "glass_cyan",
  purple_stained_glass: "glass_purple",
  blue_stained_glass: "glass_blue",
  brown_stained_glass: "glass_brown",
  green_stained_glass: "glass_green",
  red_stained_glass: "glass_red",
  black_stained_glass: "glass_black",
  white_stained_glass_pane_top: "glass_pane_top_white",
  orange_stained_glass_pane_top: "glass_pane_top_orange",
  magenta_stained_glass_pane_top: "glass_pane_top_magenta",
  light_blue_stained_glass_pane_top: "glass_pane_top_light_blue",
  yellow_stained_glass_pane_top: "glass_pane_top_yellow",
  lime_stained_glass_pane_top: "glass_pane_top_lime",
  pink_stained_glass_pane_top: "glass_pane_top_pink",
  gray_stained_glass_pane_top: "glass_pane_top_gray",
  light_gray_stained_glass_pane_top: "glass_pane_top_silver",
  cyan_stained_glass_pane_top: "glass_pane_top_cyan",
  purple_stained_glass_pane_top: "glass_pane_top_purple",
  blue_stained_glass_pane_top: "glass_pane_top_blue",
  brown_stained_glass_pane_top: "glass_pane_top_brown",
  green_stained_glass_pane_top: "glass_pane_top_green",
  red_stained_glass_pane_top: "glass_pane_top_red",
  black_stained_glass_pane_top: "glass_pane_top_black",
  // plants
  grass: "tallgrass",
  dead_bush: "deadbush",
  lily_pad: "waterlily",
  sugar_cane: "reeds",
  cobweb: "web",
  dandelion: "flower_dandelion",
  poppy: "flower_rose",
  blue_orchid: "flower_blue_orchid",
  allium: "flower_allium",
  azure_bluet: "flower_houstonia",
  red_tulip: "flower_tulip_red",
  orange_tulip: "flower_tulip_orange",
  white_tulip: "flower_tulip_white",
  pink_tulip: "flower_tulip_pink",
  oxeye_daisy: "flower_oxeye_daisy",
  cornflower: "flower_cornflower",
  lily_of_the_valley: "flower_lily_of_the_valley",
  wither_rose: "flower_wither_rose",
  brown_mushroom: "mushroom_brown",
  red_mushroom: "mushroom_red",
  brown_mushroom_block: "mushroom_block_skin_brown",
  red_mushroom_block: "mushroom_block_skin_red",
  mushroom_stem: "mushroom_block_skin_stem",
  // crops
  wheat_stage0: "wheat_stage_0",
  wheat_stage1: "wheat_stage_1",
  wheat_stage2: "wheat_stage_2",
  wheat_stage3: "wheat_stage_3",
  wheat_stage4: "wheat_stage_4",
  wheat_stage5: "wheat_stage_5",
  wheat_stage6: "wheat_stage_6",
  wheat_stage7: "wheat_stage_7",
  carrots_stage0: "carrots_stage_0",
  carrots_stage1: "carrots_stage_1",
  carrots_stage2: "carrots_stage_2",
  carrots_stage3: "carrots_stage_3",
  potatoes_stage0: "potatoes_stage_0",
  potatoes_stage1: "potatoes_stage_1",
  potatoes_stage2: "potatoes_stage_2",
  potatoes_stage3: "potatoes_stage_3",
  beetroots_stage0: "beetroots_stage_0",
  beetroots_stage1: "beetroots_stage_1",
  beetroots_stage2: "beetroots_stage_2",
  beetroots_stage3: "beetroots_stage_3",
  nether_wart_stage0: "nether_wart_stage_0",
  nether_wart_stage1: "nether_wart_stage_1",
  nether_wart_stage2: "nether_wart_stage_2",
  melon_stem: "melon_stem_disconnected",
  attached_melon_stem: "melon_stem_connected",
  pumpkin_stem: "pumpkin_stem_disconnected",
  attached_pumpkin_stem: "pumpkin_stem_connected",
  // pumpkins
  carved_pumpkin: "pumpkin_face_off",
  jack_o_lantern: "pumpkin_face_on",
  // functional blocks
  furnace_front: "furnace_front_off",
  torch: "torch_on",
  redstone_torch: "redstone_torch_on",
  redstone_torch_off: "redstone_torch_off",
  redstone_lamp: "redstone_lamp_off",
  redstone_lamp_on: "redstone_lamp_on",
  redstone_dust_dot: "redstone_dust_cross",
  redstone_dust_line0: "redstone_dust_line",
  redstone_dust_line1: "redstone_dust_line",
  repeater: "repeater_off",
  repeater_on: "repeater_on",
  comparator: "comparator_off",
  comparator_on: "comparator_on",
  daylight_detector_top: "daylight_detector_top",
  dropper_front: "dropper_front_horizontal",
  dropper_front_vertical: "dropper_front_vertical",
  dispenser_front: "dispenser_front_horizontal",
  dispenser_front_vertical: "dispenser_front_vertical",
  piston_top: "piston_top_normal",
  observer_back: "observer_rear",
  tnt_side: "tnt_side",
  // rails
  rail: "rail_normal",
  rail_corner: "rail_normal_turned",
  powered_rail: "rail_golden",
  powered_rail_on: "rail_golden_powered",
  detector_rail: "rail_detector",
  detector_rail_on: "rail_detector_powered",
  activator_rail: "rail_activator",
  activator_rail_on: "rail_activator_powered",
  // doors / trapdoors
  oak_door_top: "door_wood_upper",
  oak_door_bottom: "door_wood_lower",
  iron_door_top: "door_iron_upper",
  iron_door_bottom: "door_iron_lower",
  spruce_door_top: "door_spruce_upper",
  spruce_door_bottom: "door_spruce_lower",
  birch_door_top: "door_birch_upper",
  birch_door_bottom: "door_birch_lower",
  jungle_door_top: "door_jungle_upper",
  jungle_door_bottom: "door_jungle_lower",
  acacia_door_top: "door_acacia_upper",
  acacia_door_bottom: "door_acacia_lower",
  dark_oak_door_top: "door_dark_oak_upper",
  dark_oak_door_bottom: "door_dark_oak_lower",
  oak_trapdoor: "trapdoor",
  // anvil
  anvil: "anvil_base",
  anvil_top: "anvil_top_damaged_0",
  chipped_anvil_top: "anvil_top_damaged_1",
  damaged_anvil_top: "anvil_top_damaged_2",
  // misc
  spawner: "mob_spawner",
  sunflower_front: "double_plant_sunflower_front",
  sunflower_back: "double_plant_sunflower_back",
  sunflower_top: "double_plant_sunflower_top",
  sunflower_bottom: "double_plant_sunflower_bottom",
  lilac_top: "double_plant_syringa_top",
  lilac_bottom: "double_plant_syringa_bottom",
  rose_bush_top: "double_plant_rose_top",
  rose_bush_bottom: "double_plant_rose_bottom",
  peony_top: "double_plant_paeonia_top",
  peony_bottom: "double_plant_paeonia_bottom",
  tall_grass_top: "double_plant_grass_top",
  tall_grass_bottom: "double_plant_grass_bottom",
  large_fern_top: "double_plant_fern_top",
  large_fern_bottom: "double_plant_fern_bottom",
};

/** Java item texture name → Bedrock item texture name (both without extension). */
export const ITEM_RENAMES: Record<string, string> = {
  // tools & weapons
  wooden_sword: "wood_sword",
  wooden_pickaxe: "wood_pickaxe",
  wooden_axe: "wood_axe",
  wooden_shovel: "wood_shovel",
  wooden_hoe: "wood_hoe",
  golden_sword: "gold_sword",
  golden_pickaxe: "gold_pickaxe",
  golden_axe: "gold_axe",
  golden_shovel: "gold_shovel",
  golden_hoe: "gold_hoe",
  golden_helmet: "gold_helmet",
  golden_chestplate: "gold_chestplate",
  golden_leggings: "gold_leggings",
  golden_boots: "gold_boots",
  golden_horse_armor: "gold_horse_armor",
  bow: "bow_standby",
  fishing_rod: "fishing_rod_uncast",
  // buckets
  bucket: "bucket_empty",
  water_bucket: "bucket_water",
  lava_bucket: "bucket_lava",
  milk_bucket: "bucket_milk",
  cod_bucket: "bucket_cod",
  salmon_bucket: "bucket_salmon",
  pufferfish_bucket: "bucket_pufferfish",
  tropical_fish_bucket: "bucket_tropical",
  // food
  golden_apple: "apple_golden",
  beef: "beef_raw",
  cooked_beef: "beef_cooked",
  porkchop: "porkchop_raw",
  cooked_porkchop: "porkchop_cooked",
  chicken: "chicken_raw",
  cooked_chicken: "chicken_cooked",
  mutton: "mutton_raw",
  cooked_mutton: "mutton_cooked",
  rabbit: "rabbit_raw",
  cooked_rabbit: "rabbit_cooked",
  cod: "fish_raw",
  cooked_cod: "fish_cooked",
  salmon: "fish_salmon_raw",
  cooked_salmon: "fish_salmon_cooked",
  tropical_fish: "fish_clownfish",
  pufferfish: "fish_pufferfish_raw",
  melon_slice: "melon",
  glistering_melon_slice: "melon_speckled",
  carrot: "carrot",
  golden_carrot: "carrot_golden",
  // seeds & farming
  wheat_seeds: "seeds_wheat",
  pumpkin_seeds: "seeds_pumpkin",
  melon_seeds: "seeds_melon",
  beetroot_seeds: "seeds_beetroot",
  // dyes (pre-1.14 names on Bedrock)
  bone_meal: "dye_powder_white",
  ink_sac: "dye_powder_black",
  lapis_lazuli: "dye_powder_blue",
  cocoa_beans: "dye_powder_brown",
  white_dye: "dye_powder_white_new",
  orange_dye: "dye_powder_orange",
  magenta_dye: "dye_powder_magenta",
  light_blue_dye: "dye_powder_light_blue",
  yellow_dye: "dye_powder_yellow",
  lime_dye: "dye_powder_lime",
  pink_dye: "dye_powder_pink",
  gray_dye: "dye_powder_gray",
  light_gray_dye: "dye_powder_silver",
  cyan_dye: "dye_powder_cyan",
  purple_dye: "dye_powder_purple",
  blue_dye: "dye_powder_blue_new",
  brown_dye: "dye_powder_brown_new",
  green_dye: "dye_powder_green",
  red_dye: "dye_powder_red",
  black_dye: "dye_powder_black_new",
  // minecarts & boats
  minecart: "minecart_normal",
  chest_minecart: "minecart_chest",
  furnace_minecart: "minecart_furnace",
  tnt_minecart: "minecart_tnt",
  hopper_minecart: "minecart_hopper",
  command_block_minecart: "minecart_command_block",
  oak_boat: "boat_oak",
  spruce_boat: "boat_spruce",
  birch_boat: "boat_birch",
  jungle_boat: "boat_jungle",
  acacia_boat: "boat_acacia",
  dark_oak_boat: "boat_darkoak",
  // doors (items)
  oak_door: "door_wood",
  iron_door: "door_iron",
  spruce_door: "door_spruce",
  birch_door: "door_birch",
  jungle_door: "door_jungle",
  acacia_door: "door_acacia",
  dark_oak_door: "door_dark_oak",
  // beds
  white_bed: "bed_white",
  orange_bed: "bed_orange",
  magenta_bed: "bed_magenta",
  light_blue_bed: "bed_light_blue",
  yellow_bed: "bed_yellow",
  lime_bed: "bed_lime",
  pink_bed: "bed_pink",
  gray_bed: "bed_gray",
  light_gray_bed: "bed_silver",
  cyan_bed: "bed_cyan",
  purple_bed: "bed_purple",
  blue_bed: "bed_blue",
  brown_bed: "bed_brown",
  green_bed: "bed_green",
  red_bed: "bed_red",
  black_bed: "bed_black",
  // music discs
  music_disc_13: "record_13",
  music_disc_cat: "record_cat",
  music_disc_blocks: "record_blocks",
  music_disc_chirp: "record_chirp",
  music_disc_far: "record_far",
  music_disc_mall: "record_mall",
  music_disc_mellohi: "record_mellohi",
  music_disc_stal: "record_stal",
  music_disc_strad: "record_strad",
  music_disc_ward: "record_ward",
  music_disc_11: "record_11",
  music_disc_wait: "record_wait",
  music_disc_pigstep: "record_pigstep",
  music_disc_otherside: "record_otherside",
  music_disc_5: "record_5",
  music_disc_relic: "record_relic",
  // misc
  map: "map_empty",
  filled_map: "map_filled",
  firework_rocket: "fireworks",
  firework_star: "fireworks_charge",
  totem_of_undying: "totem",
  redstone: "redstone_dust",
  popped_chorus_fruit: "chorus_fruit_popped",
  nether_brick: "netherbrick",
  sugar_cane: "reeds",
  snowball: "snowball",
  turtle_scute: "turtle_shell_piece",
  scute: "turtle_shell_piece",
  charcoal: "charcoal",
};

export interface TextureRemapResult {
  /** Bedrock-relative output path, e.g. "textures/blocks/log_oak.png". */
  outputPath: string;
  /** True when the filename was found in a rename table (exact match). */
  exact: boolean;
}

/**
 * Remap a Java texture path (relative to pack root, e.g.
 * "assets/minecraft/textures/block/oak_log.png") to a Bedrock pack path.
 * Returns undefined for paths that need composite handling or are unmappable.
 */
export function remapVanillaTexture(javaPath: string): TextureRemapResult | undefined {
  const match = javaPath.match(/^assets\/minecraft\/textures\/([^/]+)\/(.+)\.png$/);
  if (!match) return undefined;
  const [, category, rest] = match;
  const name = rest!;

  switch (category) {
    case "block": {
      const renamed = BLOCK_RENAMES[name];
      return { outputPath: `textures/blocks/${renamed ?? name}.png`, exact: renamed !== undefined };
    }
    case "item": {
      const renamed = ITEM_RENAMES[name];
      return { outputPath: `textures/items/${renamed ?? name}.png`, exact: renamed !== undefined };
    }
    case "environment":
      return { outputPath: `textures/environment/${name}.png`, exact: false };
    case "colormap":
      return { outputPath: `textures/colormap/${name}.png`, exact: false };
    case "misc":
      return { outputPath: `textures/misc/${name}.png`, exact: false };
    case "models": {
      // Armor layers: Java "<material>_layer_N" → Bedrock "<material>_N",
      // with chainmail renamed to chain. Overlays (leather) keep their suffix:
      // leather_layer_1_overlay → leather_1_overlay.
      const armor = name.match(/^armor\/(.+?)_layer_(\d)(_overlay)?$/);
      if (armor) {
        const material = armor[1] === "chainmail" ? "chain" : armor[1];
        return {
          outputPath: `textures/models/armor/${material}_${armor[2]}${armor[3] ?? ""}.png`,
          exact: true,
        };
      }
      return { outputPath: `textures/models/${name}.png`, exact: false };
    }
    case "entity": {
      // 1.21.2+ equipment layout → Bedrock armor texture names.
      const modern = name.match(/^equipment\/(humanoid|humanoid_leggings)\/(.+)$/);
      if (modern) {
        const material = modern[2] === "chainmail" ? "chain" : modern[2];
        const layer = modern[1] === "humanoid" ? "1" : "2";
        return { outputPath: `textures/models/armor/${material}_${layer}.png`, exact: true };
      }
      // Many entity textures share paths; composites (chest, signs, beds) are
      // corrected by a later dedicated stage which overwrites these outputs.
      return { outputPath: `textures/entity/${name}.png`, exact: false };
    }
    case "map":
      return { outputPath: `textures/map/${name}.png`, exact: false };
    default:
      // gui, painting, particle, font, mob_effect, trims → dedicated stages
      return undefined;
  }
}
