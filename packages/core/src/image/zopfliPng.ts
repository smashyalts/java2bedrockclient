import { unzlibSync } from "fflate";
import { zlibAsync } from "@gfx/zopfli";
import { pngChunk } from "./png.js";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Skip files whose raw scanline data would make zopfli take forever. */
const MAX_RAW_BYTES = 4 * 1024 * 1024;

/**
 * Re-deflate a PNG's IDAT stream with zopfli (exhaustive deflate, bit-identical
 * pixels — only the compression changes). Returns the rebuilt PNG when it is
 * smaller, undefined otherwise (invalid/exotic input, or no win).
 */
export async function zopfliRecompressPng(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  if (bytes.length < 8 + 12) return undefined;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return undefined;

  // Parse chunks, keeping order; all IDATs collapse into one slot.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ordered: ({ type: string; data: Uint8Array } | "idat")[] = [];
  const idatParts: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const len = view.getUint32(offset);
    if (offset + 12 + len > bytes.length) return undefined; // truncated
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const data = bytes.subarray(offset + 8, offset + 8 + len);
    if (type === "IDAT") {
      if (idatParts.length === 0) ordered.push("idat");
      idatParts.push(data);
    } else {
      ordered.push({ type, data });
    }
    offset += 12 + len;
    if (type === "IEND") break;
  }
  if (idatParts.length === 0) return undefined;

  const zlibData = concat(idatParts);
  let raw: Uint8Array;
  try {
    raw = unzlibSync(zlibData);
  } catch {
    return undefined;
  }
  if (raw.length > MAX_RAW_BYTES) return undefined;

  // Iterations give diminishing returns; keep them modest so big packs stay
  // in reasonable time. Larger images get fewer passes.
  const numiterations = raw.length <= 64 * 1024 ? 10 : 5;
  const packed = new Uint8Array(await zlibAsync(raw, { numiterations }));
  if (packed.length >= zlibData.length) return undefined;

  const chunks: Uint8Array[] = [PNG_SIGNATURE];
  for (const entry of ordered) {
    chunks.push(entry === "idat" ? pngChunk("IDAT", packed) : pngChunk(entry.type, entry.data));
  }
  const out = concat(chunks);
  return out.length < bytes.length ? out : undefined;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
