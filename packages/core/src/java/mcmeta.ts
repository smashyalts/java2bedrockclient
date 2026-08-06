/**
 * Frame durations are whole ticks in both Java and Bedrock, but packs in the
 * wild declare fractional ones (ItemsAdder writes `"frametime": 2.1`). A
 * fractional value flows straight into frame-count arithmetic and produces
 * non-integer array lengths, so normalize it once at every read site.
 */
export function frameTicks(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.round(value));
}
