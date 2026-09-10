/**
 * Frame durations are whole ticks in both Java and Bedrock, but packs in the
 * wild declare fractional ones (ItemsAdder writes `"frametime": 2.1`). A
 * fractional value flows straight into frame-count arithmetic and produces
 * non-integer array lengths, so normalize it once at every read site.
 */
export function frameTicks(value: unknown): number {
  // Accept a numeric string too ("frametime": "3"). Number.isFinite does not
  // coerce, so those used to fall through to 1 and play the whole animation at
  // 20 fps regardless of the pack's intent — the same class of non-conforming
  // value this helper exists for.
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  return Math.max(1, Math.round(n));
}
