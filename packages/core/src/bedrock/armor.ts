/** Bedrock attachable templates for custom armor pieces and elytra. */

export type ArmorPiece = "helmet" | "chestplate" | "leggings" | "boots";

export const ARMOR_SLOTS: Record<ArmorPiece, string> = {
  helmet: "head",
  chestplate: "chest",
  leggings: "legs",
  boots: "feet",
};

const LAYER_VISIBILITY: Record<ArmorPiece, string> = {
  helmet: "variable.helmet_layer_visible = 0.0;",
  chestplate: "variable.chest_layer_visible = 0.0;",
  leggings: "variable.leg_layer_visible = 0.0;",
  boots: "variable.boot_layer_visible = 0.0;",
};

const ARMOR_GEOMETRY: Record<ArmorPiece, string> = {
  helmet: "geometry.player.armor.helmet",
  chestplate: "geometry.player.armor.chestplate",
  leggings: "geometry.player.armor.leggings",
  boots: "geometry.player.armor.boots",
};

/**
 * Armor attachable reusing the vanilla humanoid armor geometry with a custom
 * layer texture. format_version 1.20.60+ enables trim/glint support on
 * attachables (matches vanilla armor attachable structure).
 */
export function buildArmorAttachable(options: {
  identifier: string;
  piece: ArmorPiece;
  /** Texture path without extension (layer 1 for helmet/chest/boots, layer 2 for leggings). */
  texture: string;
}): object {
  return {
    format_version: "1.20.60",
    "minecraft:attachable": {
      description: {
        identifier: options.identifier,
        materials: {
          default: "armor",
          enchanted: "armor_enchanted",
        },
        textures: {
          default: options.texture,
          enchanted: "textures/misc/enchanted_item_glint",
        },
        geometry: {
          default: ARMOR_GEOMETRY[options.piece],
        },
        scripts: {
          // Hide the player skin's overlay layer under this piece, matching
          // vanilla armor attachables (e.g. helmet hides the hat layer).
          parent_setup: LAYER_VISIBILITY[options.piece],
        },
        render_controllers: ["controller.render.armor"],
      },
    },
  };
}

/** Elytra attachable with a custom wings texture. */
export function buildElytraAttachable(options: { identifier: string; texture: string }): object {
  return {
    format_version: "1.10.0",
    "minecraft:attachable": {
      description: {
        identifier: options.identifier,
        materials: {
          default: "elytra",
          enchanted: "elytra_glint",
        },
        textures: {
          default: options.texture,
          enchanted: "textures/misc/enchanted_item_glint",
        },
        geometry: {
          default: "geometry.elytra",
        },
        render_controllers: ["controller.render.armor"],
      },
    },
  };
}
