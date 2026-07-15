/// <reference lib="webworker" />
/**
 * PNG optimizer pool worker: losslessly re-optimizes one PNG per message with
 * oxipng (Squoosh's wasm build — filter search + max-effort deflate). Pixels
 * are unchanged, only the encoding shrinks. Nested under the conversion worker
 * (see zopfliPool.ts).
 *
 * oxipng (wasm-bindgen) initializes cleanly in the browser, unlike the older
 * emscripten zopfli whose runtime never fired and hung the pass.
 */
import optimise from "@jsquash/oxipng/optimise.js";

interface Job {
  id: number;
  bytes: Uint8Array;
  /** oxipng effort level 1–6; higher = more filter/deflate trials (slower, smaller). */
  level: number;
}

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, bytes, level } = e.data;
  let result: Uint8Array | undefined;
  try {
    // oxipng wants a plain ArrayBuffer holding exactly this PNG's bytes.
    const copy = bytes.slice();
    const out = new Uint8Array(
      await optimise(copy.buffer as ArrayBuffer, { level, interlace: false, optimiseAlpha: false }),
    );
    // Keep only if it actually shrank (it re-optimizes, never lossy).
    result = out.length < bytes.length ? out : undefined;
  } catch {
    result = undefined;
  }
  if (result !== undefined) {
    (self as unknown as Worker).postMessage({ id, result }, [result.buffer]);
  } else {
    (self as unknown as Worker).postMessage({ id, result: undefined });
  }
};
