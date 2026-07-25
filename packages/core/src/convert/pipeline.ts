import { readZipDetailed, writeZip } from "../io/zip.js";
import { VirtualFs } from "../io/vfs.js";
import { JavaPack } from "../java/javaPack.js";
import { ConversionReport } from "../report/report.js";
import { Timings, beginTimings, finishTimings } from "../report/timings.js";
import {
  DEFAULT_OPTIONS,
  type ConversionContext,
  type ConvertOptions,
  type PipelineStage,
  type ProgressCallback,
} from "./context.js";
import { texturesStage } from "./stages/texturesStage.js";
import { entityCompositesStage } from "./stages/entityCompositesStage.js";
import { itemsStage } from "./stages/itemsStage.js";
import { bowPullStage } from "./stages/bowPullStage.js";
import { geometryStage } from "./stages/geometryStage.js";
import { armorStage } from "./stages/armorStage.js";
import { flipbooksStage } from "./stages/flipbooksStage.js";
import { soundsStage } from "./stages/soundsStage.js";
import { langStage } from "./stages/langStage.js";
import { fontsStage } from "./stages/fontsStage.js";
import { paintingsStage } from "./stages/paintingsStage.js";
import { blocksStage } from "./stages/blocksStage.js";
import { packagingStage } from "./stages/packagingStage.js";
import { optimizeStage } from "./stages/optimizeStage.js";

export interface ConvertResult {
  /** Bedrock resource pack (.mcpack = zip). */
  mcpack: Uint8Array;
  /** geyser_mappings.json contents (undefined when no custom items were found). */
  geyserMappings: string | undefined;
  /** geyser_blocks.json contents, format_version 1 (undefined when no custom blocks). */
  geyserBlockMappings: string | undefined;
  /**
   * GeyserDisplayEntity extension mappings YAML (undefined when no furniture
   * items were found). Goes in extensions/geyserdisplayentity/Mappings/.
   */
  displayEntityMappings: string | undefined;
  /**
   * Recommended GeyserDisplayEntity `config.yml`, emitted only when furniture
   * maps onto a base item the extension hides by default (e.g.
   * leather_horse_armor). Goes in extensions/geyserdisplayentity/config.yml —
   * without it, furniture on those items shows for a frame then vanishes.
   */
  displayEntityConfig: string | undefined;
  report: ReturnType<ConversionReport["toJSON"]>;
  /** Per-stage and hot-op timing breakdown for performance analysis. */
  timings: ReturnType<Timings["toJSON"]>;
}

/** Stages run in order; later milestones insert stages between textures and packaging. */
const STAGES: PipelineStage[] = [
  texturesStage,
  entityCompositesStage,
  itemsStage,
  bowPullStage,
  geometryStage,
  armorStage,
  blocksStage,
  flipbooksStage,
  soundsStage,
  langStage,
  fontsStage,
  paintingsStage,
  packagingStage,
  optimizeStage,
];

export async function convertPack(
  zipBytes: Uint8Array,
  options?: Partial<ConvertOptions>,
  progress?: ProgressCallback,
): Promise<ConvertResult> {
  const { vfs: inputVfs, failed: unreadable } = readZipDetailed(zipBytes);
  const java = JavaPack.open(inputVfs);

  const opts: ConvertOptions = {
    packName: options?.packName ?? "Converted Pack",
    attachableMaterial: options?.attachableMaterial ?? DEFAULT_OPTIONS.attachableMaterial,
    animate2dHeldItems: options?.animate2dHeldItems ?? DEFAULT_OPTIONS.animate2dHeldItems,
    namespaces: options?.namespaces ?? DEFAULT_OPTIONS.namespaces,
    modernBaseItem: options?.modernBaseItem ?? DEFAULT_OPTIONS.modernBaseItem,
    baseItemHints: options?.baseItemHints ?? DEFAULT_OPTIONS.baseItemHints,
    displayNameHints: options?.displayNameHints ?? DEFAULT_OPTIONS.displayNameHints,
    equippableHints: options?.equippableHints ?? DEFAULT_OPTIONS.equippableHints,
    cmdItemKeys: options?.cmdItemKeys ?? DEFAULT_OPTIONS.cmdItemKeys,
    colorHints: options?.colorHints ?? DEFAULT_OPTIONS.colorHints,
    backpackItems: options?.backpackItems ?? DEFAULT_OPTIONS.backpackItems,
    furnitureItems: options?.furnitureItems ?? DEFAULT_OPTIONS.furnitureItems,
    furnitureTransforms: options?.furnitureTransforms ?? DEFAULT_OPTIONS.furnitureTransforms,
    maxAnimationFrames: options?.maxAnimationFrames ?? DEFAULT_OPTIONS.maxAnimationFrames,
    optimizePack: options?.optimizePack ?? DEFAULT_OPTIONS.optimizePack,
    maxCompression: options?.maxCompression ?? DEFAULT_OPTIONS.maxCompression,
    recompressor: options?.recompressor,
    pngEncoder: options?.pngEncoder,
  };

  const timings = new Timings();
  const ctx: ConversionContext = {
    java,
    bedrock: new VirtualFs(),
    options: opts,
    report: new ConversionReport(),
    timings,
    progress: progress ?? (() => {}),
    itemTextures: new Map(),
    terrainTextures: new Map(),
    geyserMappings: { format_version: 2, items: {} },
    geyserBlocks: {},
    pendingGeometry: [],
    bowPullGroups: [],
    fallbackBaseItemHits: 0,
    configZipProvided: false,
    definitionTextures: new Map(),
    usedBedrockIdentifiers: new Set(),
    textureCache: new Map(),
    displayEntityMappings: [],
    inferredHostItems: new Map(),
  };
  ctx.configZipProvided = opts.configZipProvided === true;

  for (const entry of unreadable) {
    ctx.report.error("ingest", entry.name, `could not extract from zip: ${entry.reason}`);
  }

  const now = (): number =>
    typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
  beginTimings(timings);
  try {
    for (const stage of STAGES) {
      ctx.progress(stage.name, 0, 1);
      const start = now();
      try {
        await stage.run(ctx);
      } catch (err) {
        ctx.report.error(stage.name, "(stage)", err instanceof Error ? err.message : String(err));
      }
      timings.stage(stage.name, now() - start);
      ctx.progress(stage.name, 1, 1);
    }
  } finally {
    finishTimings();
  }

  // Anything still pending after all stages ran was not consumed by a converter.
  for (const pending of ctx.pendingGeometry) {
    ctx.report.skipped(
      "items-3d",
      `${pending.variant.origin} → ${pending.variant.model}`,
      "3D geometry conversion not yet implemented",
    );
  }

  if (ctx.displayEntityMappings.length > 0) {
    ctx.report.converted(
      "furniture",
      `${ctx.displayEntityMappings.length} furniture item(s) from plugin configs`,
      ["geyser_displayentity_mappings.yml — install the GeyserDisplayEntity extension to show furniture on Bedrock"],
    );
  }

  // Config-zip nudge: warn when many modern items fell back to a generic base
  // item and no plugin config zip was provided to resolve real host items.
  if (ctx.fallbackBaseItemHits >= 2 && !ctx.configZipProvided) {
    ctx.report.approximated(
      "config-nudge",
      `${ctx.fallbackBaseItemHits} modern item-model assets`,
      `${ctx.fallbackBaseItemHits} modern item-model assets were mapped under ${ctx.options.modernBaseItem} because their host item isn't declared in the pack. Upload your Oraxen/Nexo/ItemsAdder config zip (under Plugin config zips above) to get real base items and display names.`,
    );
  }

  const hasMappings = Object.keys(ctx.geyserMappings.items).length > 0;
  const hasBlocks = Object.keys(ctx.geyserBlocks).length > 0;
  const zipStart = now();
  const mcpack = writeZip(ctx.bedrock);
  timings.stage("zip.write", now() - zipStart);
  return {
    mcpack,
    geyserMappings: hasMappings ? JSON.stringify(ctx.geyserMappings, null, 2) : undefined,
    geyserBlockMappings: hasBlocks
      ? JSON.stringify({ format_version: 1, blocks: ctx.geyserBlocks }, null, 2)
      : undefined,
    displayEntityMappings:
      ctx.displayEntityMappings.length > 0
        ? buildDisplayEntityYaml(ctx.displayEntityMappings)
        : undefined,
    displayEntityConfig:
      ctx.displayEntityMappings.length > 0
        ? buildDisplayEntityConfig(new Set(ctx.displayEntityMappings.map((e) => e.type)))
        : undefined,
    report: ctx.report.toJSON(),
    timings: timings.toJSON(),
  };
}

/**
 * GeyserDisplayEntity extension mappings YAML for furniture items. The
 * extension equips the (already converted) custom item on a stand-in entity
 * wherever the server spawns an item_display, so Bedrock players see
 * furniture; per-item options let testers tune offsets.
 */
function buildDisplayEntityYaml(
  entries: {
    key: string;
    type: string;
    identifier: string;
    modelData?: number;
    vanillaScale?: boolean;
    yOffset?: number;
  }[],
): string {
  const lines = [
    "# GeyserDisplayEntity mappings — generated by GeyserConverter.",
    "# Requires the GeyserDisplayEntity Geyser extension:",
    "#   https://github.com/GeyserExtensionists/GeyserDisplayEntity",
    "# Install: drop the extension jar in Geyser's extensions/ folder, then put",
    "# this file in extensions/geyserdisplayentity/Mappings/.",
    "#",
    "# Placement — rotation, height and (when enabled) scale — is applied at",
    "# runtime by the extension reading the server's item_display entity. The",
    "# pack ships only raw geometry; nothing is baked. This mirrors how",
    "# production furniture packs convert 1:1, so a chair the server places",
    "# stands upright and sits at the right height without per-item tuning.",
    "#",
    "# vanilla-scale makes the extension apply the entity's own scale — set from",
    "# the plugin's furniture scale. y-offset is 0 for furniture the extension",
    "# repositions live; NONE-transform furniture (no runtime transform) gets a",
    "# negative y-offset so it's seated instead of hanging at the item anchor.",
    "# The global default y-offset (-0.5) lives in config.yml. If a piece still",
    "# floats, lower its y-offset here; if it sinks, raise it.",
    "mappings:",
  ];
  for (const e of entries) {
    lines.push(`  ${e.key}:`);
    lines.push(`    type: "${e.type}"`);
    if (e.modelData !== undefined) {
      lines.push(`    model-data: ${e.modelData}`);
      lines.push(`    item-identifier: "none"`);
    } else {
      lines.push(`    item-identifier: "${e.identifier}"`);
    }
    const vanilla = e.vanillaScale ?? false;
    lines.push("    displayentityoptions:");
    lines.push(`      y-offset: ${(e.yOffset ?? 0).toFixed(3)}`);
    lines.push(`      vanilla-scale: ${vanilla}`);
    lines.push(`      vanilla-scale-multiplier: ${vanilla ? 1 : 0}`);
    lines.push("      hand: false");
  }
  return lines.join("\n") + "\n";
}

/**
 * GeyserDisplayEntity config.yml. The global `y-offset` (-0.5) and `height`
 * (1.7) here are what seat furniture on the floor — the per-item mappings keep
 * y-offset 0 and rely on these. Without a matching config the stand-in entity
 * renders the model at chest height, so furniture floats ~1 block up. This
 * mirrors the config a production 1:1 furniture server runs, so we always emit
 * it alongside the mappings. `hide-types` (default minecraft:bone) hides stray
 * vanilla item-displays; any furniture base item that lands in it is removed so
 * the furniture isn't hidden too.
 */
const HIDE_TYPE_DEFAULTS = ["minecraft:bone"];

function buildDisplayEntityConfig(furnitureBaseItems: Set<string>): string {
  const hideTypes = HIDE_TYPE_DEFAULTS.filter((t) => !furnitureBaseItems.has(t));
  const yamlList = (items: string[]): string =>
    items.length === 0 ? " []" : "\n" + items.map((t) => `  - "${t}"`).join("\n");
  return [
    "# GeyserDisplayEntity config.yml — generated by GeyserConverter.",
    "# Drop this in extensions/geyserdisplayentity/config.yml (back up your own",
    "# first if you've customised it). The general values below seat furniture on",
    "# the floor — y-offset/height compensate for the stand-in entity's chest",
    "# anchor. Without them furniture floats ~1 block up. hide-types hides stray",
    "# vanilla item-displays; this converter's furniture base items are removed",
    "# from it so they render instead of being hidden.",
    "general:",
    "  use-legacy-models: true",
    "  height: 1.7",
    "  y-offset: -0.5",
    "  vanilla-scale: false",
    "  vanilla-scale-multiplier: 1",
    "  hand: false",
    `hide-types:${yamlList(hideTypes)}`,
    "",
  ].join("\n");
}
