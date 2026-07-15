/// <reference lib="webworker" />
import { expose } from "comlink";
import {
  convertPack,
  parseOraxenConfigZips,
  type ConvertOptions,
  type ConvertResult,
} from "@geyser-converter/core";
import { createZopfliPool, poolSize } from "./zopfliPool.js";
import { createEncodePool } from "./encodePool.js";

export interface WorkerApi {
  convert(
    zipBytes: Uint8Array,
    options: Partial<ConvertOptions>,
    onProgress: (stage: string, done: number, total: number) => void,
    /** Optional plugin config zips (Nexo/Oraxen/ItemsAdder/HMCCosmetics, any mix). */
    configZips?: Uint8Array[],
    /** oxipng effort level (4–6) for the max-compression pass. */
    oxipngLevel?: number,
  ): Promise<ConvertResult & { hintCount?: number }>;
}

const api: WorkerApi = {
  async convert(zipBytes, options, onProgress, configZips, oxipngLevel) {
    let hintCount: number | undefined;
    if (configZips !== undefined && configZips.length > 0) {
      const hints = parseOraxenConfigZips(configZips);
      options = {
        ...options,
        baseItemHints: hints.baseItems,
        displayNameHints: hints.displayNames,
        equippableHints: hints.equippables,
        cmdItemKeys: hints.cmdKeys,
        colorHints: hints.colors,
        backpackItems: hints.backpacks,
        furnitureItems: hints.furniture,
      };
      hintCount = hints.items;
    }
    // Parallelize the geometry stage's PNG encoding (the conversion hotspot)
    // across a worker pool; workers spawn lazily so small packs pay nothing.
    const encodePool = createEncodePool(poolSize());
    // Parallelize the slow zopfli max-compression pass across a worker pool so
    // it finishes in ~1/cores of the single-threaded time.
    const pool = options.maxCompression ? createZopfliPool(poolSize(), oxipngLevel ?? 4) : undefined;
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
