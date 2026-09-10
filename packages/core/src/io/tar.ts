import { gunzipSync } from "fflate";
import { VirtualFs } from "./vfs.js";
import type { ReadZipResult } from "./zip.js";

/** gzip magic: 0x1f 0x8b. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

const BLOCK = 512;
const decoder = new TextDecoder();

/** Read a NUL-terminated ASCII field from a header block. */
function readStr(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end++;
  return decoder.decode(block.subarray(offset, end));
}

/**
 * Parse a numeric header field (size, etc.), tolerating spaces/NULs.
 *
 * GNU tar encodes any value that will not fit the 11 octal digits — i.e. an
 * entry over 8 GiB — in base 256, flagged by the high bit of the first byte.
 * parseInt cannot read that and returned 0, which made the reader advance a
 * single block and then interpret the entry's payload as tar headers, filling
 * the pack with garbage entries instead of failing.
 */
function readOctal(block: Uint8Array, offset: number, length: number): number {
  const first = block[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    // Base-256: big-endian, high bit of byte 0 is the marker (and sign bit).
    let value = first & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + (block[offset + i] ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  const s = readStr(block, offset, length).trim();
  if (s === "") return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a (already-decompressed) tar archive into files. Handles ustar regular
 * files with the `prefix` field, GNU long names ('L'), and pax extended headers
 * ('x' → `path=`); directories and other entry types are skipped. Malformed
 * archives stop at the first bad header rather than throwing.
 */
export function parseTar(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const files: { name: string; data: Uint8Array }[] = [];
  let pos = 0;
  let overrideName: string | undefined; // from a preceding 'L' or pax header

  while (pos + BLOCK <= bytes.length) {
    const header = bytes.subarray(pos, pos + BLOCK);
    // End of archive: a zero-filled block.
    if (header.every((b) => b === 0)) break;

    const size = readOctal(header, 124, 12);
    const typeflag = header[156];
    const dataStart = pos + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) break; // truncated
    const data = bytes.subarray(dataStart, dataEnd);

    if (typeflag === 0x4c /* 'L' GNU longname */) {
      overrideName = readStr(data, 0, data.length).replace(/\0+$/, "");
    } else if (typeflag === 0x78 /* 'x' */ || typeflag === 0x67 /* 'g' */) {
      // pax header: records "<len> key=value\n"; we only want path.
      const text = decoder.decode(data);
      const m = text.match(/\d+ path=([^\n]*)\n/);
      if (m) overrideName = m[1];
    } else if (typeflag === 0 || typeflag === 0x30 /* '0' regular */) {
      let name = overrideName;
      if (name === undefined) {
        const base = readStr(header, 0, 100);
        const prefix = readStr(header, 345, 155);
        name = prefix ? `${prefix}/${base}` : base;
      }
      overrideName = undefined;
      // Old tars record directories as a regular entry whose name ends in "/".
      // The zip reader skips those explicitly; without the same guard the two
      // readers behind readZipDetailed disagreed on what a file is, and the
      // phantom entries reached the merge report and the output zip.
      if (name !== "" && !name.endsWith("/")) files.push({ name, data: data.slice() });
    } else {
      // Directory ('5') or other metadata — skip, clear any pending name.
      overrideName = undefined;
    }

    // Advance past the data, rounded up to the next 512-byte block.
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

/** Decompress a .tar.gz / .tgz and read it into a VirtualFs. */
export function readTarGzDetailed(bytes: Uint8Array): ReadZipResult {
  const tar = gunzipSync(bytes);
  const vfs = new VirtualFs();
  for (const entry of parseTar(tar)) {
    vfs.write(entry.name, entry.data);
  }
  return { vfs, failed: [] };
}
