/// <reference lib="webworker" />
import { expose } from "comlink";
import {
  convertPack,
  parseOraxenConfigZips,
  type ConvertOptions,
  type ConvertResult,
} from "@geyser-converter/core";
import { createEncodePool } from "./encodePool.js";
import { createZopfliPool, poolSize } from "./zopfliPool.js";

export interface WorkerApi {
  convert(
    /**
     * One pack, or several to merge into a single Bedrock pack (list order is
     * priority — the first pack wins any file two of them both define).
     */
    zipBytes: Uint8Array | Uint8Array[],
    options: Partial<ConvertOptions>,
    onProgress: (stage: string, done: number, total: number) => void,
    /** Optional plugin config zips (Nexo/Oraxen/ItemsAdder/CraftEngine/HMCCosmetics, any mix). */
    configZips?: Uint8Array[],
    /** oxipng effort level (4–6) for the max-compression pass. */
    oxipngLevel?: number,
  ): Promise<ConvertResult & { hintCount?: number }>;
}

const api: WorkerApi = {
  async convert(zipBytes, options, onProgress, configZips, oxipngLevel) {
    // The page shows "reading files" from the moment it starts reading the drop
    // until the first stage reports, which hides both the config parse and the
    // unzip + index of the pack. On a large pack that is a silent window with
    // no way to tell work from a hang, so name each step as it begins.
    let hintCount: number | undefined;
    if (configZips !== undefined && configZips.length > 0) {
      onProgress("reading plugin configs", 0, 1);
      // Config zips are optional, so a bad one must not kill the run. The
      // parsers call readZipDetailed with no guard, which throws on a truncated
      // or mis-named archive — previously taking down a conversion whose actual
      // resource pack was fine, with an error that named neither the file nor
      // the fact that it was the optional input.
      let hints;
      try {
        hints = parseOraxenConfigZips(configZips);
      } catch (err) {
        throw new Error(
          `A plugin config / datapack zip could not be read (${err instanceof Error ? err.message : String(err)}). ` +
            `Remove it and convert again — the resource pack itself is unaffected.`,
        );
      }
      options = {
        ...options,
        baseItemHints: hints.baseItems,
        displayNameHints: hints.displayNames,
        equippableHints: hints.equippables,
        cmdItemKeys: hints.cmdKeys,
        colorHints: hints.colors,
        backpackItems: hints.backpacks,
        furnitureItems: hints.furniture,
        furnitureTransforms: hints.furnitureTransforms,
        configZipProvided: true,
        // Scanned for .bbmodel ModelEngine blueprints (kept raw; hints above are
        // the parsed form). Copy so the transfer of `bytes` below can't neuter them.
        pluginConfigZips: configZips.map((z) => z.slice()),
      };
      hintCount = hints.items;
    }
    // Parallelize the geometry stage's PNG encoding (the conversion hotspot)
    // across a worker pool; workers spawn lazily so small packs pay nothing.
    const encodePool = createEncodePool(poolSize());
    // Parallelize the slow oxipng max-compression pass across a worker pool so
    // it finishes in ~1/cores of the single-threaded time. Each job is bounded
    // by a timeout, so a browser that can't init the wasm keeps the original
    // bytes and the pass still completes (never freezes).
    // Spawning is eager (unlike the encode pool), so gate on optimizePack too:
    // optimizeStage returns immediately when it is off, and booting eight
    // oxipng wasm workers that are then terminated unused puts wasm init on the
    // critical path of every earlier stage for nothing.
    onProgress("opening pack", 0, 1);
    const wantsRecompress = options.maxCompression === true && options.optimizePack !== false;
    const pool = wantsRecompress ? createZopfliPool(poolSize(), oxipngLevel ?? 4) : undefined;
    options = { ...options, pngEncoder: encodePool };
    if (pool !== undefined) options = { ...options, recompressor: pool };
    try {
      const result = await convertPack(zipBytes, options, (stage, done, total) => {
        onProgress(stage, done, total);
      });
      return { ...result, hintCount };
    } finally {
      pool?.dispose();
      encodePool.dispose();
    }
  },
};

expose(api);
