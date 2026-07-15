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
  report: ReturnType<ConversionReport["toJSON"]>;
  /** Per-stage and hot-op timing breakdown for performance analysis. */
  timings: ReturnType<Timings["toJSON"]>;
}

/** Stages run in order; later milestones insert stages between textures and packaging. */
const STAGES: PipelineStage[] = [
  texturesStage,
  entityCompositesStage,
  itemsStage,
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
    namespaces: options?.namespaces ?? DEFAULT_OPTIONS.namespaces,
    modernBaseItem: options?.modernBaseItem ?? DEFAULT_OPTIONS.modernBaseItem,
    baseItemHints: options?.baseItemHints ?? DEFAULT_OPTIONS.baseItemHints,
    displayNameHints: options?.displayNameHints ?? DEFAULT_OPTIONS.displayNameHints,
    equippableHints: options?.equippableHints ?? DEFAULT_OPTIONS.equippableHints,
    cmdItemKeys: options?.cmdItemKeys ?? DEFAULT_OPTIONS.cmdItemKeys,
    colorHints: options?.colorHints ?? DEFAULT_OPTIONS.colorHints,
    backpackItems: options?.backpackItems ?? DEFAULT_OPTIONS.backpackItems,
    furnitureItems: options?.furnitureItems ?? DEFAULT_OPTIONS.furnitureItems,
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
    definitionTextures: new Map(),
    usedBedrockIdentifiers: new Set(),
    displayEntityMappings: [],
  };

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
  entries: { key: string; type: string; identifier: string; modelData?: number }[],
): string {
  const lines = [
    "# GeyserDisplayEntity mappings — generated by GeyserConverter.",
    "# Requires the GeyserDisplayEntity Geyser extension:",
    "#   https://github.com/GeyserExtensionists/GeyserDisplayEntity",
    "# Install: drop the extension jar in Geyser's extensions/ folder, then put",
    "# this file in extensions/geyserdisplayentity/Mappings/.",
    "# Tune y-offset (and vanilla-scale) per item if furniture floats or sinks.",
    "mappings:",
  ];
  for (const e of entries) {
    lines.push(`  ${e.key}:`);
    lines.push(`    type: "${e.type}"`);
    if (e.modelData !== undefined) {
      lines.push(`    model-data: ${e.modelData}`);
    } else {
      lines.push(`    item-identifier: "${e.identifier}"`);
    }
    lines.push("    displayentityoptions:");
    lines.push("      y-offset: -0.5");
  }
  return lines.join("\n") + "\n";
}
