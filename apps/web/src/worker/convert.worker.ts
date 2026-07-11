/// <reference lib="webworker" />
import { expose } from "comlink";
import {
  convertPack,
  parseOraxenConfigZip,
  type ConvertOptions,
  type ConvertResult,
} from "@geyser-converter/core";

export interface WorkerApi {
  convert(
    zipBytes: Uint8Array,
    options: Partial<ConvertOptions>,
    onProgress: (stage: string, done: number, total: number) => void,
    /** Optional Oraxen/Nexo config zip — parsed for per-item base-item hints. */
    configZip?: Uint8Array,
  ): Promise<ConvertResult & { hintCount?: number }>;
}

const api: WorkerApi = {
  async convert(zipBytes, options, onProgress, configZip) {
    let hintCount: number | undefined;
    if (configZip !== undefined) {
      const hints = parseOraxenConfigZip(configZip);
      options = {
        ...options,
        baseItemHints: hints.baseItems,
        displayNameHints: hints.displayNames,
        equippableHints: hints.equippables,
        cmdItemKeys: hints.cmdKeys,
        backpackItems: hints.backpacks,
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
