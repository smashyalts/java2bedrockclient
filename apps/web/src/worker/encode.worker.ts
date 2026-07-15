/// <reference lib="webworker" />
/**
 * PNG encode pool worker: encodes one RGBA image per message with the core
 * encoder (indexed / grayscale / RGBA — smallest wins), the exact same routine
 * the pipeline uses in-process. Parallelizing this across workers spreads the
 * geometry stage's atlas/icon encoding (the conversion hotspot) over all cores.
 * Nested under the conversion worker (see encodePool.ts).
 */
import { encodePng } from "@geyser-converter/core";

interface Job {
  id: number;
  width: number;
  height: number;
  data: Uint8Array;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, width, height, data } = e.data;
  let png: Uint8Array | undefined;
  try {
    png = encodePng({ width, height, data });
  } catch {
    png = undefined; // core falls back to in-process encode for this one
  }
  if (png !== undefined) {
    (self as unknown as Worker).postMessage({ id, png }, [png.buffer]);
  } else {
    (self as unknown as Worker).postMessage({ id, png: undefined });
  }
};
