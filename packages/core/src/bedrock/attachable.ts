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
 * Render controller that selects a texture frame based on charge progress.
 * Used for bow-pull (and similar charge-based) held items.
 *
 * The texture index advances from 0 (resting) through N-1 (fully charged)
 * as the player draws the bow. The charge fraction is computed in the
 * attachable's pre_animation script (`v.charge_amount`) and stored on
 * the context; this controller indexes into the texture array by
 * `math.floor(v.charge_amount * (N - 1))`, clamped to [0, N-1].
 */
export function buildBowPullRenderController(options: {
  /** e.g. "controller.render.gc_bow". */
  id: string;
  /** Texture shortnames in charge order: [standby, pulling_0, pulling_1, pulling_2]. */
  frameShortnames: string[];
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
          `Array.frames[math.min(${count - 1}, math.floor(v.charge_amount * ${count}))]`,
        ],
      },
    },
  };
}

/**
 * Builds a Bedrock attachable for a bow-pull item. Same structure as
 * `buildItemAttachable` but injects a `v.charge_amount` pre_animation
 * variable and references the bow-pull render controller.
 */
export function buildBowPullAttachable(options: {
  /** e.g. "geyser_custom:bow" — must match the mapping's bedrock_identifier. */
  identifier: string;
  material: string;
  /** Texture path without extension, e.g. "textures/geyser_custom/bow_standby". */
  texture: string;
  /** e.g. "geometry.geyser_custom.bow". */
  geometry: string;
  /** animation key → animation identifier. */
  animations: Record<string, string>;
  /** Extra texture shortname → path entries (pull-stage textures). */
  extraTextures: Record<string, string>;
  /** Custom render controller id (bow-pull). */
  renderController: string;
  /** Max use duration in ticks (Java: bow=72000, crossbow=25). Default 72000. */
  maxUseDuration?: number;
}): object {
  const maxTicks = options.maxUseDuration ?? 72000;
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
          ...options.extraTextures,
        },
        geometry: {
          default: options.geometry,
        },
        scripts: {
          pre_animation: [
            "v.main_hand = c.item_slot == 'main_hand';",
            "v.off_hand = c.item_slot == 'off_hand';",
            "v.head = c.item_slot == 'head';",
            // Charge fraction: 0 at rest, 1 when fully drawn.
            // q.use_duration grows as the player holds use; maxUseDuration
            // is the Java item's max-use ticks (bow=72000, crossbow=25).
            `v.charge_amount = math.min(1.0, q.use_duration / ${maxTicks}.0);`,
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
