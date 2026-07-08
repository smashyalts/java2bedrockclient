import { inflateSync } from "fflate";

/**
 * Resilient zip reader. Pack "protection" tools (Oraxen, PackSquash modes)
 * deliberately corrupt local file headers, add fake entries with lying sizes,
 * or prepend junk — enough to crash naive extractors while Minecraft (which
 * reads the central directory) still loads the pack. We do what Minecraft
 * does: trust only the central directory, read each entry defensively, and
 * skip anything that fails instead of aborting the whole archive.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface ZipReadResult {
  entries: ZipEntry[];
  /** Entries listed in the central directory that could not be extracted. */
  failed: { name: string; reason: string }[];
}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** Refuse to allocate more than this for one entry (defends lying size fields). */
const MAX_ENTRY_SIZE = 512 * 1024 * 1024;

export function readZipResilient(bytes: Uint8Array): ZipReadResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: ZipReadResult = { entries: [], failed: [] };

  // Find the LAST end-of-central-directory record (protection tools sometimes
  // plant fake ones earlier in the file).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip file (no end-of-central-directory record)");

  const totalEntries = view.getUint16(eocd + 10, true);
  let cdirOffset = view.getUint32(eocd + 16, true);

  // Junk may be prepended to the file, shifting real offsets. Locate the actual
  // central directory start by scanning for its signature near the claimed offset.
  if (cdirOffset >= bytes.length || view.getUint32(cdirOffset, true) !== CDIR_SIG) {
    const cdirSize = view.getUint32(eocd + 12, true);
    const guess = eocd - cdirSize;
    if (guess >= 0 && guess < bytes.length - 4 && view.getUint32(guess, true) === CDIR_SIG) {
      cdirOffset = guess;
    } else {
      throw new Error("central directory not found");
    }
  }
  /** Difference between claimed and actual positions (prepended junk). */
  const shift = cdirOffset - view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder("utf-8");
  let ptr = cdirOffset;
  const seen = new Set<string>();

  for (let i = 0; i < totalEntries && ptr + 46 <= bytes.length; i++) {
    if (view.getUint32(ptr, true) !== CDIR_SIG) break;
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLength = view.getUint16(ptr + 28, true);
    const extraLength = view.getUint16(ptr + 30, true);
    const commentLength = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true) + shift;
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLength));
    ptr += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/") || name.length === 0) continue; // directory
    if (seen.has(name)) continue; // duplicate entry (protection trick) — first wins
    seen.add(name);

    try {
      result.entries.push({
        name,
        data: extractEntry(bytes, view, name, localOffset, method, compressedSize, uncompressedSize),
      });
    } catch (err) {
      result.failed.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (result.entries.length === 0) {
    throw new Error("no readable entries in zip");
  }
  return result;
}

function extractEntry(
  bytes: Uint8Array,
  view: DataView,
  name: string,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array {
  if (localOffset < 0 || localOffset + 30 > bytes.length) {
    throw new Error("local header out of bounds");
  }
  if (view.getUint32(localOffset, true) !== LOCAL_SIG) {
    throw new Error("corrupt local header signature");
  }
  // Local header name/extra lengths are frequently the corrupted part —
  // read them but sanity-check against the file bounds.
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  if (dataStart + compressedSize > bytes.length || compressedSize > MAX_ENTRY_SIZE) {
    throw new Error("entry data out of bounds (lying sizes)");
  }
  // The uncompressed-size field is a favourite corruption target (Oraxen sets
  // 0xFFFFFFFF everywhere, which makes size-trusting extractors allocate 4 GB).
  // We never allocate from it — inflate produces the real size on its own.

  const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) {
    return compressed.slice();
  }
  if (method === 8) {
    return inflateSync(compressed);
  }
  throw new Error(`unsupported compression method ${method}`);
}
