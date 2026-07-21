import type { JavaModel } from "../java/model.js";

/**
 * Built-in vanilla model parents. Packs reference these without shipping them,
 * so the resolver falls back here when a parent is not in the pack. Definitions
 * mirror the vanilla assets (block/block display transforms, cube family, cross).
 */
export const BUILTIN_MODELS: Record<string, JavaModel> = {
  "minecraft:block/block": {
    display: {
      gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] },
      ground: { rotation: [0, 0, 0], translation: [0, 3, 0], scale: [0.25, 0.25, 0.25] },
      fixed: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [0.5, 0.5, 0.5] },
      thirdperson_righthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] },
      firstperson_righthand: { rotation: [0, 45, 0], translation: [0, 0, 0], scale: [0.4, 0.4, 0.4] },
      firstperson_lefthand: { rotation: [0, 225, 0], translation: [0, 0, 0], scale: [0.4, 0.4, 0.4] },
    },
  },
  "minecraft:block/cube": {
    parent: "minecraft:block/block",
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          down: { texture: "#down", cullface: "down" },
          up: { texture: "#up", cullface: "up" },
          north: { texture: "#north", cullface: "north" },
          south: { texture: "#south", cullface: "south" },
          west: { texture: "#west", cullface: "west" },
          east: { texture: "#east", cullface: "east" },
        },
      },
    ],
  },
  "minecraft:block/cube_all": {
    parent: "minecraft:block/cube",
    textures: {
      particle: "#all",
      down: "#all",
      up: "#all",
      north: "#all",
      east: "#all",
      south: "#all",
      west: "#all",
    },
  },
  "minecraft:block/cube_column": {
    parent: "minecraft:block/cube",
    textures: {
      particle: "#side",
      down: "#end",
      up: "#end",
      north: "#side",
      east: "#side",
      south: "#side",
      west: "#side",
    },
  },
  "minecraft:block/cube_bottom_top": {
    parent: "minecraft:block/cube",
    textures: {
      particle: "#side",
      down: "#bottom",
      up: "#top",
      north: "#side",
      east: "#side",
      south: "#side",
      west: "#side",
    },
  },
  "minecraft:block/orientable_with_bottom": {
    parent: "minecraft:block/cube",
    textures: {
      particle: "#front",
      down: "#bottom",
      up: "#top",
      north: "#front",
      east: "#side",
      south: "#side",
      west: "#side",
    },
  },
  "minecraft:block/orientable": {
    parent: "minecraft:block/orientable_with_bottom",
    textures: { bottom: "#top" },
  },
  "minecraft:block/cross": {
    parent: "minecraft:block/block",
    textures: { particle: "#cross" },
    elements: [
      {
        from: [0.8, 0, 8],
        to: [15.2, 16, 8],
        rotation: { origin: [8, 8, 8], axis: "y", angle: 45, rescale: true },
        shade: false,
        faces: {
          north: { uv: [0, 0, 16, 16], texture: "#cross" },
          south: { uv: [0, 0, 16, 16], texture: "#cross" },
        },
      },
      {
        from: [8, 0, 0.8],
        to: [8, 16, 15.2],
        rotation: { origin: [8, 8, 8], axis: "y", angle: -45, rescale: true },
        shade: false,
        faces: {
          west: { uv: [0, 0, 16, 16], texture: "#cross" },
          east: { uv: [0, 0, 16, 16], texture: "#cross" },
        },
      },
    ],
  },
  "minecraft:block/tinted_cross": {
    parent: "minecraft:block/cross",
  },

  // --- Vanilla item model parents ---
  // Packs reference these without shipping them. Only the `parent` field is
  // needed — the resolver follows the chain to the generic terminal parent
  // (generated / handheld / handheld_rod) for kind classification, and
  // inferHostItemFromModel uses the specific vanilla item name in the chain
  // to infer the host item for custom-namespace modern items.
  "minecraft:item/diamond_sword": { parent: "minecraft:item/handheld" },
  "minecraft:item/iron_sword": { parent: "minecraft:item/handheld" },
  "minecraft:item/golden_sword": { parent: "minecraft:item/handheld" },
  "minecraft:item/netherite_sword": { parent: "minecraft:item/handheld" },
  "minecraft:item/stone_sword": { parent: "minecraft:item/handheld" },
  "minecraft:item/wooden_sword": { parent: "minecraft:item/handheld" },
  "minecraft:item/diamond_pickaxe": { parent: "minecraft:item/handheld" },
  "minecraft:item/iron_pickaxe": { parent: "minecraft:item/handheld" },
  "minecraft:item/golden_pickaxe": { parent: "minecraft:item/handheld" },
  "minecraft:item/netherite_pickaxe": { parent: "minecraft:item/handheld" },
  "minecraft:item/stone_pickaxe": { parent: "minecraft:item/handheld" },
  "minecraft:item/wooden_pickaxe": { parent: "minecraft:item/handheld" },
  "minecraft:item/diamond_axe": { parent: "minecraft:item/handheld" },
  "minecraft:item/iron_axe": { parent: "minecraft:item/handheld" },
  "minecraft:item/golden_axe": { parent: "minecraft:item/handheld" },
  "minecraft:item/netherite_axe": { parent: "minecraft:item/handheld" },
  "minecraft:item/stone_axe": { parent: "minecraft:item/handheld" },
  "minecraft:item/wooden_axe": { parent: "minecraft:item/handheld" },
  "minecraft:item/diamond_shovel": { parent: "minecraft:item/handheld" },
  "minecraft:item/iron_shovel": { parent: "minecraft:item/handheld" },
  "minecraft:item/golden_shovel": { parent: "minecraft:item/handheld" },
  "minecraft:item/netherite_shovel": { parent: "minecraft:item/handheld" },
  "minecraft:item/stone_shovel": { parent: "minecraft:item/handheld" },
  "minecraft:item/wooden_shovel": { parent: "minecraft:item/handheld" },
  "minecraft:item/diamond_hoe": { parent: "minecraft:item/handheld" },
  "minecraft:item/iron_hoe": { parent: "minecraft:item/handheld" },
  "minecraft:item/golden_hoe": { parent: "minecraft:item/handheld" },
  "minecraft:item/netherite_hoe": { parent: "minecraft:item/handheld" },
  "minecraft:item/stone_hoe": { parent: "minecraft:item/handheld" },
  "minecraft:item/wooden_hoe": { parent: "minecraft:item/handheld" },
  "minecraft:item/stick": { parent: "minecraft:item/handheld" },
  "minecraft:item/blaze_rod": { parent: "minecraft:item/handheld" },
  "minecraft:item/bone": { parent: "minecraft:item/handheld" },
  "minecraft:item/shears": { parent: "minecraft:item/handheld" },
  "minecraft:item/flint_and_steel": { parent: "minecraft:item/handheld" },
  "minecraft:item/fishing_rod": { parent: "minecraft:item/handheld_rod" },
  "minecraft:item/bow": { parent: "minecraft:item/generated" },
  "minecraft:item/crossbow": { parent: "minecraft:item/generated" },
};

export function lookupBuiltinModel(id: string): JavaModel | undefined {
  const normalized = id.includes(":") ? id : `minecraft:${id}`;
  return BUILTIN_MODELS[normalized];
}
