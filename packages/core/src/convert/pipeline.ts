import { readZipDetailed, writeZip } from "../io/zip.js";
import { VirtualFs } from "../io/vfs.js";
import { JavaPack } from "../java/javaPack.js";
import { ConversionReport } from "../report/report.js";
import {
  DEFAULT_OPTIONS,
  type ConversionContext,
  type ConvertOptions,
  type PipelineStage,
  type ProgressCallback,
} from "./context.js";
import { texturesStage } from "./stages/texturesStage.js";
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

export interface ConvertResult {
  /** Bedrock resource pack (.mcpack = zip). */
  mcpack: Uint8Array;
  /** geyser_mappings.json contents (undefined when no custom items were found). */
  geyserMappings: string | undefined;
  /** geyser_blocks.json contents, format_version 1 (undefined when no custom blocks). */
  geyserBlockMappings: string | undefined;
  report: ReturnType<ConversionReport["toJSON"]>;
}

/** Stages run in order; later milestones insert stages between textures and packaging. */
const STAGES: PipelineStage[] = [
  texturesStage,
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
    maxAnimationFrames: options?.maxAnimationFrames ?? DEFAULT_OPTIONS.maxAnimationFrames,
  };

  const ctx: ConversionContext = {
    java,
    bedrock: new VirtualFs(),
    options: opts,
    report: new ConversionReport(),
    progress: progress ?? (() => {}),
    itemTextures: new Map(),
    terrainTextures: new Map(),
    geyserMappings: { format_version: 2, items: {} },
    geyserBlocks: {},
    pendingGeometry: [],
    definitionTextures: new Map(),
  };

  for (const entry of unreadable) {
    ctx.report.error("ingest", entry.name, `could not extract from zip: ${entry.reason}`);
  }

  for (const stage of STAGES) {
    ctx.progress(stage.name, 0, 1);
    try {
      await stage.run(ctx);
    } catch (err) {
      ctx.report.error(stage.name, "(stage)", err instanceof Error ? err.message : String(err));
    }
    ctx.progress(stage.name, 1, 1);
  }

  // Anything still pending after all stages ran was not consumed by a converter.
  for (const pending of ctx.pendingGeometry) {
    ctx.report.skipped(
      "items-3d",
      `${pending.variant.origin} → ${pending.variant.model}`,
      "3D geometry conversion not yet implemented",
    );
  }

  const hasMappings = Object.keys(ctx.geyserMappings.items).length > 0;
  const hasBlocks = Object.keys(ctx.geyserBlocks).length > 0;
  return {
    mcpack: writeZip(ctx.bedrock),
    geyserMappings: hasMappings ? JSON.stringify(ctx.geyserMappings, null, 2) : undefined,
    geyserBlockMappings: hasBlocks
      ? JSON.stringify({ format_version: 1, blocks: ctx.geyserBlocks }, null, 2)
      : undefined,
    report: ctx.report.toJSON(),
  };
}
