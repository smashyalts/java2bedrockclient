import type { PngRecompressor } from "@geyser-converter/core";

interface Reply {
  id: number;
  result: Uint8Array | undefined;
}

/** Per-file zopfli budget. Some browsers never initialize the zopfli wasm, so
 *  a job can hang forever; if one exceeds this we drop it (keep the original)
 *  and recycle the worker, guaranteeing the pass completes. A real recompress
 *  of a ≤4MB texture finishes in a couple of seconds, so this is generous. */
const JOB_TIMEOUT_MS = 12000;

function spawn(): Worker {
  return new Worker(new URL("./zopfli.worker.ts", import.meta.url), { type: "module" });
}

/**
 * A Web Worker pool implementing the core PngRecompressor interface. Spreads
 * the (slow, single-threaded) zopfli recompression of the maxCompression pass
 * across N workers so a big pack finishes in ~1/N of the time.
 *
 * Plain workers + postMessage — no SharedArrayBuffer, so this works on static
 * hosts (GitHub Pages) that can't set the COOP/COEP headers wasm threads need.
 * Each job is bounded by a timeout; a worker that hangs on a file is terminated
 * and replaced, so the pass always makes progress and never freezes the UI.
 */
export function createZopfliPool(size: number): PngRecompressor & { dispose(): void } {
  let workers: Worker[] = [];
  for (let i = 0; i < Math.max(1, size); i++) workers.push(spawn());

  return {
    dispose(): void {
      for (const w of workers) w.terminate();
      workers = [];
    },

    run(pngs, onProgress) {
      return new Promise((resolve) => {
        const results = new Array<Uint8Array | undefined>(pngs.length);
        if (pngs.length === 0) {
          resolve(results);
          return;
        }
        let next = 0;
        let done = 0;

        const finish = (id: number, result: Uint8Array | undefined): void => {
          results[id] = result;
          done++;
          onProgress?.(done, pngs.length);
          if (done === pngs.length) resolve(results);
        };

        // Keep one worker busy on one job at a time; hand it the next job when
        // it replies (or when its current job times out and it's replaced).
        const pump = (worker: Worker, slot: number): void => {
          if (next >= pngs.length) return;
          const id = next++;
          let settled = false;

          const onMessage = (e: MessageEvent<Reply>): void => {
            if (e.data.id !== id || settled) return;
            settled = true;
            clearTimeout(timer);
            worker.removeEventListener("message", onMessage);
            finish(id, e.data.result);
            pump(worker, slot);
          };
          worker.addEventListener("message", onMessage);

          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            worker.removeEventListener("message", onMessage);
            worker.terminate();
            finish(id, undefined); // keep the original PNG
            const replacement = spawn();
            workers[slot] = replacement;
            pump(replacement, slot);
          }, JOB_TIMEOUT_MS);

          // Do NOT transfer the input buffer — the VFS still holds it and needs
          // it intact when zopfli returns undefined (no shrink). Structured
          // clone copies it to the worker; the (fresh) result is transferred back.
          worker.postMessage({ id, bytes: pngs[id] });
        };

        workers.forEach((w, slot) => pump(w, slot));
      });
    },
  };
}

/** Reasonable pool size: leave a core for the UI, cap so we don't thrash. */
export function poolSize(): number {
  const cores = (globalThis.navigator?.hardwareConcurrency ?? 4) as number;
  return Math.max(1, Math.min(8, cores - 1));
}
