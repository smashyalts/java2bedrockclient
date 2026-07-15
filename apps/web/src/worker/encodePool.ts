import { encodePng, type PngEncoder, type RawImage } from "@geyser-converter/core";

interface Reply {
  id: number;
  png: Uint8Array | undefined;
}

/**
 * A Web Worker pool implementing the core PngEncoder interface. Spreads the
 * geometry stage's atlas/icon PNG encoding across N workers so a big pack's
 * encode pass finishes in ~1/N of the single-threaded time.
 *
 * Plain workers + postMessage — no SharedArrayBuffer, so this works on static
 * hosts (GitHub Pages) that can't set the COOP/COEP headers wasm threads need.
 * Workers spawn lazily on the first encode so small packs (which encode inline)
 * pay no worker-startup cost. If a worker fails on an image it returns
 * undefined and we encode that one in-process, so output is never lost.
 */
export function createEncodePool(size: number): PngEncoder & { dispose(): void } {
  const count = Math.max(1, size);
  let workers: Worker[] | undefined;

  const ensureWorkers = (): Worker[] => {
    if (workers === undefined) {
      workers = [];
      for (let i = 0; i < count; i++) {
        workers.push(new Worker(new URL("./encode.worker.ts", import.meta.url), { type: "module" }));
      }
    }
    return workers;
  };

  return {
    dispose(): void {
      for (const w of workers ?? []) w.terminate();
      workers = undefined;
    },

    encode(images: RawImage[]): Promise<Uint8Array[]> {
      return new Promise((resolve) => {
        const results = new Array<Uint8Array>(images.length);
        if (images.length === 0) {
          resolve(results);
          return;
        }
        const pool = ensureWorkers();
        let next = 0;
        let done = 0;

        const finish = (id: number, png: Uint8Array | undefined): void => {
          // A worker that failed returns undefined — encode that image here so
          // the result is always present.
          results[id] = png ?? encodePng(images[id]!);
          done++;
          if (done === images.length) resolve(results);
        };

        // Keep each worker busy on one image at a time; hand it the next when it replies.
        const pump = (worker: Worker): void => {
          if (next >= images.length) return;
          const id = next++;

          const onMessage = (e: MessageEvent<Reply>): void => {
            if (e.data.id !== id) return;
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            worker.removeEventListener("messageerror", onMessageError);
            clearTimeout(timer);
            finish(id, e.data.png);
            pump(worker);
          };
          worker.addEventListener("message", onMessage);

          const onError = (_e: ErrorEvent): void => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            worker.removeEventListener("messageerror", onMessageError);
            clearTimeout(timer);
            finish(id, undefined); // in-process fallback
            pump(worker);
          };
          worker.addEventListener("error", onError);

          // messageerror: data could not be deserialized — treat as failure.
          const onMessageError = (): void => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            worker.removeEventListener("messageerror", onMessageError);
            clearTimeout(timer);
            finish(id, undefined);
            pump(worker);
          };
          worker.addEventListener("messageerror", onMessageError);

          // Safety timeout: if the worker is silently killed (OOM, tab crash),
          // the message/error events never fire. Fall back to in-process encode.
          const timer = setTimeout(() => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            worker.removeEventListener("messageerror", onMessageError);
            finish(id, undefined);
            pump(worker);
          }, 30000);

          // Do NOT transfer the input buffer — the core keeps the image for the
          // in-process fallback if the worker returns undefined. Structured
          // clone copies it in; the fresh PNG is transferred back.
          const img = images[id]!;
          worker.postMessage({ id, width: img.width, height: img.height, data: img.data });
        };

        for (const w of pool) pump(w);
      });
    },
  };
}
