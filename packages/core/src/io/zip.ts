import { zipSync, type Zippable } from "fflate";
import { VirtualFs } from "./vfs.js";
import { readZipResilient } from "./zipReader.js";

export interface ReadZipResult {
  vfs: VirtualFs;
  /** Central-directory entries that could not be extracted (corrupt/fake). */
  failed: { name: string; reason: string }[];
}

/**
 * Read a zip archive into a VirtualFs, tolerating deliberately corrupted
 * archives ("pack protection"). Unreadable entries are reported, not fatal.
 */
export function readZipDetailed(bytes: Uint8Array): ReadZipResult {
  const result = readZipResilient(bytes);
  const vfs = new VirtualFs();
  for (const entry of result.entries) {
    vfs.write(entry.name, entry.data);
  }
  return { vfs, failed: result.failed };
}

/** Read a zip archive into a VirtualFs. Directory entries are skipped. */
export function readZip(bytes: Uint8Array): VirtualFs {
  return readZipDetailed(bytes).vfs;
}

/**
 * Write a VirtualFs to a zip archive.
 * PNG/OGG are stored uncompressed-ish (level 0 would bloat mcpack; use level 6 for
 * text, 0 for already-compressed formats to speed things up).
 */
export function writeZip(vfs: VirtualFs): Uint8Array {
  const tree: Zippable = {};
  for (const [path, data] of vfs.entries()) {
    const alreadyCompressed = /\.(png|ogg|jpg|jpeg|zip|mcpack)$/i.test(path);
    tree[path] = alreadyCompressed ? [data, { level: 0 }] : [data, { level: 6 }];
  }
  return zipSync(tree);
}
