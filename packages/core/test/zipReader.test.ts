import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { readZipDetailed } from "../src/index.js";

function protectedZip(files: Record<string, string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = new TextEncoder().encode(content);
  }
  const zip = zipSync(tree, { level: 6 });
  // Simulate Oraxen pack protection: set every uncompressed-size field in the
  // central directory (and local headers) to 0xFFFFFFFF.
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = 0; i < zip.length - 4; i++) {
    const sig = view.getUint32(i, true);
    if (sig === 0x02014b50) view.setUint32(i + 24, 0xffffffff, true); // central dir usize
    if (sig === 0x04034b50) view.setUint32(i + 22, 0xffffffff, true); // local header usize
  }
  return zip;
}

describe("resilient zip reader", () => {
  it("reads archives with corrupted uncompressed-size fields (Oraxen protection)", () => {
    const zip = protectedZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 34 } }),
      "assets/oraxen/models/item/thing.json": JSON.stringify({ parent: "minecraft:item/generated" }),
    });
    const { vfs, failed } = readZipDetailed(zip);
    expect(failed).toHaveLength(0);
    expect(vfs.has("pack.mcmeta")).toBe(true);
    expect(JSON.parse(vfs.readText("pack.mcmeta")!).pack.pack_format).toBe(34);
  });

  it("skips corrupt entries instead of failing the archive", () => {
    const zip = protectedZip({ "a.txt": "hello", "b.txt": "world" });
    // Corrupt the first local header signature.
    zip[0] = 0x00;
    const { vfs, failed } = readZipDetailed(zip);
    expect(failed.length).toBe(1);
    expect(vfs.readText("b.txt")).toBe("world");
  });
});
