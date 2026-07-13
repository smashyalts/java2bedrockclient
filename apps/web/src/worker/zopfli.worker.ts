/// <reference lib="webworker" />
/**
 * Zopfli pool worker: recompresses one PNG per message with the zopfli wasm.
 * Nested under the conversion worker (see zopfliPool.ts). Pixels are unchanged
 * — only the deflate stream is re-packed — so this is lossless.
 */
import { zopfliRecompressPng } from "@geyser-converter/core";

interface Job {
  id: number;
  bytes: Uint8Array;
}

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, bytes } = e.data;
  let result: Uint8Array | undefined;
  try {
    result = await zopfliRecompressPng(bytes);
  } catch {
    result = undefined;
  }
  if (result !== undefined) {
    (self as unknown as Worker).postMessage({ id, result }, [result.buffer]);
  } else {
    (self as unknown as Worker).postMessage({ id, result: undefined });
  }
};
