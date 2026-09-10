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

/**
 * Rewrite a normal zip into ZIP64 form: sentinel the 32-bit EOCD fields and
 * insert a ZIP64 end-of-central-directory record plus its locator. This is what
 * any writer produces once a pack passes 65,535 entries or 4 GB, which real
 * ItemsAdder/Nexo packs do.
 */
function toZip64(zip: Uint8Array): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("fixture has no EOCD");
  const entries = view.getUint16(eocd + 10, true);
  const cdirSize = view.getUint32(eocd + 12, true);
  const cdirOffset = view.getUint32(eocd + 16, true);

  const z64 = new Uint8Array(56);
  const z64v = new DataView(z64.buffer);
  z64v.setUint32(0, 0x06064b50, true);
  z64v.setBigUint64(4, BigInt(44), true);        // size of remaining record
  z64v.setUint16(12, 45, true);                  // version made by
  z64v.setUint16(14, 45, true);                  // version needed
  z64v.setBigUint64(24, BigInt(entries), true);  // entries on this disk
  z64v.setBigUint64(32, BigInt(entries), true);  // total entries
  z64v.setBigUint64(40, BigInt(cdirSize), true);
  z64v.setBigUint64(48, BigInt(cdirOffset), true);

  const loc = new Uint8Array(20);
  const locv = new DataView(loc.buffer);
  locv.setUint32(0, 0x07064b50, true);
  locv.setBigUint64(8, BigInt(eocd), true);      // where the ZIP64 EOCD lands
  locv.setUint32(16, 1, true);                   // total disks

  const tail = zip.slice(eocd);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  tailView.setUint16(10, 0xffff, true);          // sentinel entry count
  tailView.setUint32(12, 0xffffffff, true);      // sentinel cdir size
  tailView.setUint32(16, 0xffffffff, true);      // sentinel cdir offset

  const out = new Uint8Array(eocd + z64.length + loc.length + tail.length);
  out.set(zip.slice(0, eocd), 0);
  out.set(z64, eocd);
  out.set(loc, eocd + z64.length);
  out.set(tail, eocd + z64.length + loc.length);
  return out;
}

describe("ZIP64 archives", () => {
  it("reads an archive whose 32-bit EOCD fields are sentinels", () => {
    const plain = zipSync({
      "pack.mcmeta": new TextEncoder().encode(`{"pack":{"pack_format":34}}`),
      "assets/x/textures/a.png": new TextEncoder().encode("first"),
      "assets/x/textures/b.png": new TextEncoder().encode("second"),
    });
    const { vfs, failed } = readZipDetailed(toZip64(plain));
    expect(failed).toHaveLength(0);
    expect(vfs.readText("assets/x/textures/a.png")).toBe("first");
    expect(vfs.readText("assets/x/textures/b.png")).toBe("second");
    expect(vfs.has("pack.mcmeta")).toBe(true);
  });
});
