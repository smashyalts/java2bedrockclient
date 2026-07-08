import { sha256 } from "@noble/hashes/sha2";

/**
 * Deterministic UUID derived from a seed string, so re-converting the same
 * pack name produces the same header UUID and Bedrock treats it as an update
 * rather than a new pack.
 */
export function deterministicUuid(seed: string): string {
  const hash = sha256(new TextEncoder().encode(seed));
  const bytes = hash.slice(0, 16);
  // Set version (4) and variant bits so it is a syntactically valid UUID.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ManifestOptions {
  name: string;
  description: string;
  version?: [number, number, number];
  minEngineVersion?: [number, number, number];
}

/**
 * Monotonically increasing version derived from the conversion time. Bedrock
 * caches packs by UUID+version; keeping the UUID stable but bumping the
 * version on every conversion makes clients re-download without users having
 * to clear their resource cache.
 */
function timestampVersion(): [number, number, number] {
  const minutes = Math.floor(Date.now() / 60_000);
  return [1, Math.floor(minutes / 65536) % 65536, minutes % 65536];
}

export function buildManifest(options: ManifestOptions): object {
  const version = options.version ?? timestampVersion();
  return {
    format_version: 2,
    header: {
      name: options.name,
      description: options.description,
      uuid: deterministicUuid("header:" + options.name),
      version,
      min_engine_version: options.minEngineVersion ?? [1, 21, 0],
    },
    modules: [
      {
        type: "resources",
        uuid: deterministicUuid("module:" + options.name),
        version,
      },
    ],
  };
}
