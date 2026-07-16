import { zipSync, type Zippable } from "fflate";
import { VirtualFs } from "./vfs.js";
import { readZipResilient } from "./zipReader.js";
import { isGzip, readTarGzDetailed } from "./tar.js";

export interface ReadZipResult {
  vfs: VirtualFs;
  /** Central-directory entries that could not be extracted (corrupt/fake). */
  failed: { name: string; reason: string }[];
}

/**
 * Read a resource-pack archive into a VirtualFs. Accepts zip/.mcpack and
 * gzipped tar (.tar.gz / .tgz — e.g. a `git archive` of a pack). Zip reading
 * tolerates deliberately corrupted archives ("pack protection"); unreadable
 * entries are reported, not fatal.
 */
export function readZipDetailed(bytes: Uint8Array): ReadZipResult {
  if (isGzip(bytes)) return readTarGzDetailed(bytes);
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
 * Already-compressed formats (PNG/OGG) are stored raw — deflating them again
 * only wastes CPU. Text gets max deflate; JSON is pre-minified so this is cheap.
 */
export function writeZip(vfs: VirtualFs): Uint8Array {
  const tree: Zippable = {};
  for (const [path, data] of vfs.entries()) {
    const alreadyCompressed = /\.(png|ogg|jpg|jpeg|zip|mcpack)$/i.test(path);
    tree[path] = alreadyCompressed ? [data, { level: 0 }] : [data, { level: 9 }];
  }
  return zipSync(tree);
}
