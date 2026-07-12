/// <reference lib="webworker" />
import { expose } from "comlink";
import {
  convertPack,
  parseOraxenConfigZips,
  type ConvertOptions,
  type ConvertResult,
} from "@geyser-converter/core";

export interface WorkerApi {
  convert(
    zipBytes: Uint8Array,
    options: Partial<ConvertOptions>,
    onProgress: (stage: string, done: number, total: number) => void,
    /** Optional plugin config zips (Nexo/Oraxen/ItemsAdder/HMCCosmetics, any mix). */
    configZips?: Uint8Array[],
  ): Promise<ConvertResult & { hintCount?: number }>;
}

const api: WorkerApi = {
  async convert(zipBytes, options, onProgress, configZips) {
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
    const result = await convertPack(zipBytes, options, (stage, done, total) => {
      onProgress(stage, done, total);
    });
    return { ...result, hintCount };
  },
};

expose(api);
