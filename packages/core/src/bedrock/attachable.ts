/** Builds a Bedrock attachable definition for a held/worn custom item. */
export function buildItemAttachable(options: {
  /** e.g. "geyser_custom:ruby_sword" — must match the mapping's bedrock_identifier. */
  identifier: string;
  material: string;
  /** Texture path without extension, e.g. "textures/geyser_custom/atlases/ruby_sword". */
  texture: string;
  /** e.g. "geometry.geyser_custom.ruby_sword". */
  geometry: string;
  /** animation key → animation identifier. */
  animations: Record<string, string>;
  /** Extra texture shortname → path entries (flipbook frames). */
  extraTextures?: Record<string, string>;
  /** Custom render controller id (flipbook); defaults to the vanilla item controller. */
  renderController?: string;
}): object {
  return {
    format_version: "1.10.0",
    "minecraft:attachable": {
      description: {
        identifier: options.identifier,
        materials: {
          default: options.material,
          enchanted: options.material,
        },
        textures: {
          default: options.texture,
          enchanted: "textures/misc/enchanted_item_glint",
          ...(options.extraTextures ?? {}),
        },
        geometry: {
          default: options.geometry,
        },
        scripts: {
          pre_animation: [
            "v.main_hand = c.item_slot == 'main_hand';",
            "v.off_hand = c.item_slot == 'off_hand';",
            "v.head = c.item_slot == 'head';",
          ],
          animate: [
            { thirdperson_main_hand: "v.main_hand && !c.is_first_person" },
            { thirdperson_off_hand: "v.off_hand && !c.is_first_person" },
            { firstperson_main_hand: "v.main_hand && c.is_first_person" },
            { firstperson_off_hand: "v.off_hand && c.is_first_person" },
            { head: "v.head" },
          ],
        },
        animations: options.animations,
        render_controllers: [options.renderController ?? "controller.render.item_default"],
      },
    },
  };
}

/**
 * Render controller cycling through frame textures on a time index —
 * the standard Bedrock technique for animated held items (flipbooks have no
 * native support on attachables).
 */
export function buildFlipbookRenderController(options: {
  /** e.g. "controller.render.gc_ruby_sword". */
  id: string;
  /** Texture shortnames in frame order, e.g. ["default", "frame1", "frame2"]. */
  frameShortnames: string[];
  /** Frames per second (Java frametime is in ticks: fps = 20 / frametime). */
  fps: number;
}): object {
  const count = options.frameShortnames.length;
  return {
    format_version: "1.10.0",
    render_controllers: {
      [options.id]: {
        arrays: {
          textures: {
            "Array.frames": options.frameShortnames.map((n) => `Texture.${n}`),
          },
        },
        geometry: "Geometry.default",
        materials: [{ "*": "Material.default" }],
        textures: [
          `Array.frames[math.mod(math.floor(q.life_time * ${options.fps}), ${count})]`,
        ],
      },
    },
  };
}

/**
 * Render controller that selects a texture frame from bow draw progress.
 *
 * Frame 0 is the resting look (not drawing). Frames 1..N are the pull stages
 * in ascending threshold order. `v.charge_amount` (set in the attachable's
 * pre_animation, = Bedrock use-duration mapped into Java's post-scale [0,1]
 * domain) is compared against each stage threshold, highest first, exactly as
 * Java's range_dispatch picks "the highest threshold ≤ value".
 */
export function buildBowPullRenderController(options: {
  /** e.g. "controller.render.gc_bow". */
  id: string;
  /** Texture shortnames: [standby, stage0, stage1, …] (standby first). */
  frameShortnames: string[];
  /** Thresholds for stages 1..N (same length as frameShortnames minus the standby). */
  stageThresholds: number[];
  /**
   * Geometry shortnames parallel to frameShortnames, when each pull stage has
   * its own 3D mesh (custom-model bows). Omit for flat sprite bows that share
   * one geometry.
   */
  geometryShortnames?: string[];
}): object {
  // Build a ternary ladder so the HIGHEST matching threshold wins (Java's
  // range_dispatch picks the highest threshold ≤ value). Wrapping lowest→highest
  // leaves the highest threshold as the outermost (first-evaluated) test.
  // Not drawing (charge <= 0) → frame 0 (standby).
  const n = options.stageThresholds.length;
  let expr = "0";
  for (let i = 0; i < n; i++) {
    const frameIndex = i + 1; // frame 0 is standby
    expr = `(v.charge_amount >= ${options.stageThresholds[i]!.toFixed(4)} ? ${frameIndex} : ${expr})`;
  }
  expr = `(v.charge_amount <= 0.0 ? 0 : ${expr})`;
  const controller: Record<string, unknown> = {
    arrays: {
      textures: {
        "Array.frames": options.frameShortnames.map((name) => `Texture.${name}`),
      },
    },
    geometry: "Geometry.default",
    materials: [{ "*": "Material.default" }],
    textures: [`Array.frames[${expr}]`],
  };
  if (options.geometryShortnames !== undefined) {
    (controller.arrays as Record<string, unknown>).geometries = {
      "Array.geos": options.geometryShortnames.map((name) => `Geometry.${name}`),
    };
    controller.geometry = `Array.geos[${expr}]`;
  }
  return {
    format_version: "1.10.0",
    render_controllers: { [options.id]: controller },
  };
}

/**
 * Builds a Bedrock attachable for a bow-pull item. Same structure as
 * `buildItemAttachable` but computes `v.charge_amount` each frame from the
 * held item's use duration and references the bow-pull render controller.
 */
export function buildBowPullAttachable(options: {
  /** e.g. "geyser_custom:bow" — must match the mapping's bedrock_identifier. */
  identifier: string;
  material: string;
  /**
   * Texture shortname → path (without extension). Must include "default"
   * (the standby texture); pull stages are the remaining entries.
   */
  textures: Record<string, string>;
  /**
   * Geometry shortname → geometry id. Must include "default". A single entry
   * is a flat sprite bow (one shared mesh); multiple entries give each pull
   * stage its own 3D mesh, selected by the render controller.
   */
  geometries: Record<string, string>;
  /** animation key → animation identifier. */
  animations: Record<string, string>;
  /** Custom render controller id (bow-pull). */
  renderController: string;
  /**
   * Java range_dispatch scale on the pull property (bow use_duration = 0.05).
   * Bedrock `query.main_hand_item_use_duration` is in seconds; a 20-tick draw
   * is 1s, so charge = use_duration_seconds * (20 * scale) reproduces Java's
   * post-scale value (= use_duration_seconds for the usual 0.05 scale).
   */
  scale: number;
}): object {
  const chargeMultiplier = 20 * options.scale;
  return {
    format_version: "1.10.0",
    "minecraft:attachable": {
      description: {
        identifier: options.identifier,
        materials: {
          default: options.material,
          enchanted: options.material,
        },
        textures: {
          ...options.textures,
          enchanted: "textures/misc/enchanted_item_glint",
        },
        geometry: {
          ...options.geometries,
        },
        scripts: {
          pre_animation: [
            "v.main_hand = c.item_slot == 'main_hand';",
            "v.off_hand = c.item_slot == 'off_hand';",
            "v.head = c.item_slot == 'head';",
            // Draw progress in Java's post-scale [0,1] domain. The query is 0
            // when the item isn't being used, and grows while it's drawn.
            `v.charge_amount = q.main_hand_item_use_duration * ${chargeMultiplier.toFixed(4)};`,
          ],
          animate: [
            { thirdperson_main_hand: "v.main_hand && !c.is_first_person" },
            { thirdperson_off_hand: "v.off_hand && !c.is_first_person" },
            { firstperson_main_hand: "v.main_hand && c.is_first_person" },
            { firstperson_off_hand: "v.off_hand && c.is_first_person" },
            { head: "v.head" },
          ],
        },
        animations: options.animations,
        render_controllers: [options.renderController],
      },
    },
  };
}
