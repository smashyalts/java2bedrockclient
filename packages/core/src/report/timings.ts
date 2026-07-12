/**
 * Lightweight performance instrumentation. Per-stage durations come from the
 * pipeline loop; hot low-level ops (PNG encode/decode, atlas stitch, icon
 * render) report into a module-global sink so pure helpers don't have to
 * thread a context through every call.
 *
 * The sink is safe because a conversion runs to completion synchronously on a
 * single event loop before the next begins (web worker: one at a time; API:
 * awaits each convertPack). `begin()`/`finish()` bracket one conversion.
 */

const now = (): number =>
  typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();

export interface OpStat {
  count: number;
  totalMs: number;
}

export class Timings {
  readonly stages: { name: string; ms: number }[] = [];
  readonly ops = new Map<string, OpStat>();

  stage(name: string, ms: number): void {
    this.stages.push({ name, ms: Math.round(ms) });
  }

  record(category: string, ms: number): void {
    const stat = this.ops.get(category) ?? { count: 0, totalMs: 0 };
    stat.count++;
    stat.totalMs += ms;
    this.ops.set(category, stat);
  }

  toJSON(): {
    totalMs: number;
    stages: { name: string; ms: number }[];
    ops: { category: string; count: number; totalMs: number }[];
  } {
    return {
      totalMs: Math.round(this.stages.reduce((n, s) => n + s.ms, 0)),
      stages: this.stages,
      ops: [...this.ops.entries()]
        .map(([category, s]) => ({ category, count: s.count, totalMs: Math.round(s.totalMs) }))
        .sort((a, b) => b.totalMs - a.totalMs),
    };
  }
}

/** Active sink for the conversion in flight (see file header for the safety argument). */
let active: Timings | undefined;

export function beginTimings(timings: Timings): void {
  active = timings;
}

export function finishTimings(): void {
  active = undefined;
}

/** Time a synchronous hot op into the active sink (no-op when instrumentation is off). */
export function timeOp<T>(category: string, fn: () => T): T {
  if (active === undefined) return fn();
  const start = now();
  try {
    return fn();
  } finally {
    active.record(category, now() - start);
  }
}

/** Time an async hot op into the active sink. */
export async function timeOpAsync<T>(category: string, fn: () => Promise<T>): Promise<T> {
  if (active === undefined) return fn();
  const start = now();
  try {
    return await fn();
  } finally {
    active.record(category, now() - start);
  }
}
