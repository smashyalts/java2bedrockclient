import type { JavaPack } from "../java/javaPack.js";
import type { VirtualFs } from "../io/vfs.js";
import type { ConversionReport } from "../report/report.js";
import type { Timings } from "../report/timings.js";
import type { RgbaImage } from "../image/png.js";

export interface ConvertOptions {
  /** Bedrock pack name shown in-game; defaults to Java pack description or zip name. */
  packName: string;
  /** Material used for generated attachables. */
  attachableMaterial: string;
  /** Namespaces to convert; empty = all. */
  namespaces: string[];
  /**
   * Host item used for modern item-model assets whose base item cannot be
   * known statically (servers usually apply them via the item_model component).
   */
  modernBaseItem: string;
  /**
   * Item-model name → java item id overrides, e.g. from parsed Oraxen/Nexo
   * configs ("ruby_sword" → "minecraft:diamond_sword"). Keys are lowercase
   * names without namespace.
   */
  baseItemHints: Record<string, string>;
  /** Item-model name → display name from plugin configs (colour codes stripped). */
  displayNameHints: Record<string, string>;
  /** Item-model name → equippable armor link from plugin configs. */
  equippableHints: Record<string, { asset: string; slot: string }>;
  /** "minecraft:material|cmd" → config item key (cmd-dispatched packs). */
  cmdItemKeys: Record<string, string>;
  /**
   * Item-model name → fixed dye colour (0xRRGGBB) from plugin configs.
   * Baked into 2D icons of server-tinted base items (leather, potions).
   */
  colorHints: Record<string, number>;
  /** Item keys worn as back cosmetics (armor-stand head items) — get a head lift. */
  backpackItems: string[];
  /**
   * Item keys placed as world furniture (display entities). Matched definitions
   * are emitted into a GeyserDisplayEntity extension mappings YAML so Bedrock
   * players can see them (requires the GeyserDisplayEntity Geyser extension).
   */
  furnitureItems: string[];
  /**
   * Max flipbook timeline frames per animated item; 0 = unlimited (full
   * animation, default). Lower values shrink the pack for slow connections.
   */
  maxAnimationFrames: number;
  /**
   * Lossless output optimization (default true): minify pack JSON and merge
   * byte-identical generated textures. Never changes what the client renders.
   */
  optimizePack: boolean;
  /**
   * Opt-in zopfli recompression of large PNGs (default false). Squeezes ~12%
   * more off big textures but is very slow (single-threaded wasm, ~0.7s per
   * file) — minutes on a large pack. The default lossless wins run regardless.
   */
  maxCompression: boolean;
  /**
   * Optional parallel PNG recompressor for the maxCompression pass — the web
   * build injects a Web Worker pool so zopfli runs across all cores. When
   * absent (node CLI/API) the pass falls back to in-process sequential zopfli.
   */
  recompressor?: PngRecompressor;
  /**
   * Optional parallel PNG encoder — the web build injects a Web Worker pool so
   * the geometry stage's atlas/icon encodes (the conversion hotspot) run across
   * all cores. When absent (node CLI/API) the stage encodes in-process.
   */
  pngEncoder?: PngEncoder;
  /**
   * Whether a plugin config zip was provided by the caller. Set by the web
   * worker / API when config zips are present; used to suppress the nudge.
   */
  configZipProvided?: boolean;
}

/** A batch RGBA→PNG encoder; implemented in the web app as a worker pool. */
export interface PngEncoder {
  /** Encode each image with the core encoder (indexed/grayscale/RGBA, smallest wins). */
  encode(images: RawImage[]): Promise<Uint8Array[]>;
}

/** Plain RGBA image payload (structured-clone friendly, no methods). */
export interface RawImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A batch PNG recompressor; implemented in the web app as a worker pool. */
export interface PngRecompressor {
  /**
   * Recompress each PNG losslessly (pixels unchanged). Returns a smaller
   * encoding per input, or undefined where nothing shrank. May run in parallel.
   */
  run(
    pngs: Uint8Array[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<(Uint8Array | undefined)[]>;
}

export const DEFAULT_OPTIONS: Omit<ConvertOptions, "packName"> = {
  attachableMaterial: "entity_alphatest_one_sided",
  namespaces: [],
  modernBaseItem: "minecraft:paper",
  baseItemHints: {},
  displayNameHints: {},
  equippableHints: {},
  cmdItemKeys: {},
  colorHints: {},
  backpackItems: [],
  furnitureItems: [],
  maxAnimationFrames: 0,
  optimizePack: true,
  maxCompression: false,
};

export type ProgressCallback = (stage: string, done: number, total: number) => void;

/** Shared state threaded through all pipeline stages. */
export interface ConversionContext {
  java: JavaPack;
  /** Bedrock resource pack under construction. */
  bedrock: VirtualFs;
  options: ConvertOptions;
  report: ConversionReport;
  timings: Timings;
  progress: ProgressCallback;
  /**
   * Accumulators filled by stages and flushed at packaging time:
   * item_texture.json entries, geyser mappings, flipbooks, sounds, …
   */
  itemTextures: Map<string, { textures: string }>;
  /** terrain_texture.json entries for custom block textures. */
  terrainTextures: Map<string, { textures: string }>;
  geyserMappings: GeyserMappingsV2;
  /** Geyser custom blocks mappings (format_version 1), keyed by java block id. */
  geyserBlocks: Record<string, GeyserBlockDefinition>;
  /** 3D item variants collected by the items stage for the geometry stage. */
  pendingGeometry: PendingGeometry[];
  /**
   * Java texture ids each definition's model referenced — lets the armor stage
   * link renamed items (e.g. "solar_boots") to their armor set ("akira") via
   * texture paths when name matching fails.
   */
  definitionTextures: Map<GeyserItemDefinition, string[]>;
  /** Bedrock identifiers already assigned (must be unique across definitions). */
  usedBedrockIdentifiers: Set<string>;
  /**
   * Shared decoded-texture cache keyed by Java VFS path. Avoids re-decoding
   * the same PNG across the items, blocks, geometry, and optimize stages.
   */
  textureCache: Map<string, RgbaImage | undefined>;
  /**
   * Bow-pull groups detected from legacy overrides — consumed by the
   * bowPullStage to emit charge-progress render controllers.
   */
  bowPullGroups: import("../java/itemVariants.js").BowPullGroup[];
  /**
   * Count of modern item-model assets that fell back to `modernBaseItem`
   * because their host item wasn't declared in the pack. Used by the
   * config-nudge to warn the user.
   */
  fallbackBaseItemHits: number;
  /**
   * Whether a plugin config zip (Oraxen/Nexo/ItemsAdder/HMCCosmetics) was
   * provided. When false and fallbackBaseItemHits > 0, the nudge fires.
   */
  configZipProvided: boolean;
  /**
   * Furniture definitions for the GeyserDisplayEntity extension mappings YAML:
   * config key, host java item, bedrock identifier name (no namespace), and
   * the legacy cmd value when the pack dispatches on custom_model_data.
   */
  displayEntityMappings: {
    key: string;
    type: string;
    identifier: string;
    modelData?: number;
    /**
     * Per-item vertical offset for the GeyserDisplayEntity stand-in, derived
     * from the furniture model's vertical centre (Java units → blocks). The
     * extension's default -0.5 assumes a standard 1-block item (centre at y=8);
     * this generalises it so tall furniture doesn't float.
     */
    yOffset?: number;
    /**
     * Java `display.fixed` rotation (degrees, [x,y,z]) baked by the client for
     * item_displays but dropped by the attachable. Emitted into the extension's
     * `displayentityoptions.rotation` so furniture that's modelled lying down
     * (a chair with a -90 X rotation) stands upright on Bedrock instead of
     * rendering flat. Omitted when the model has no fixed rotation.
     */
    rotation?: [number, number, number];
  }[];
}

export interface PendingGeometry {
  variant: import("../java/itemVariants.js").ItemVariant;
  resolved: import("../resolve/modelResolver.js").ResolvedModel;
}

/** Geyser Custom Item API v2 mappings file model (built incrementally). */
export interface GeyserMappingsV2 {
  format_version: 2;
  items: Record<string, GeyserItemDefinition[]>;
}

export interface GeyserItemDefinition {
  type: "definition" | "legacy" | "group";
  model?: string;
  custom_model_data?: number;
  bedrock_identifier?: string;
  display_name?: string;
  priority?: number;
  predicate?: unknown;
  predicate_strategy?: "and" | "or";
  bedrock_options?: {
    icon?: string;
    display_handheld?: boolean;
    allow_offhand?: boolean;
    creative_category?: string;
    creative_group?: string;
    protection_value?: number;
    tags?: string[];
  };
  components?: Record<string, unknown>;
  definitions?: GeyserItemDefinition[];
}

export interface GeyserBlockDefinition {
  name: string;
  display_name?: string;
  /** Object form ({identifier}) — matches what current Geyser builds parse. */
  geometry?: { identifier: string };
  material_instances?: Record<string, GeyserMaterialInstance>;
  only_override_states?: boolean;
  state_overrides?: Record<string, Partial<GeyserBlockDefinition>>;
  destructible_by_mining?: number;
  light_emission?: number;
}

export interface GeyserMaterialInstance {
  texture: string;
  render_method?: string;
  face_dimming?: boolean;
  ambient_occlusion?: boolean;
}

export interface PipelineStage {
  name: string;
  run(ctx: ConversionContext): void | Promise<void>;
}
