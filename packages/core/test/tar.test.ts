import { describe, expect, it } from "vitest";
import { gzipSync } from "fflate";
import { parseTar, readTarGzDetailed, isGzip } from "../src/io/tar.js";
import { convertPack } from "../src/index.js";

/** Build a minimal ustar archive from {name, data} entries. */
function buildTar(files: { name: string; data: Uint8Array | string }[]): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const f of files) {
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const header = new Uint8Array(512);
    header.set(enc.encode(f.name), 0);
    header.set(enc.encode("0000644\0"), 100); // mode
    header.set(enc.encode("0000000\0"), 108); // uid
    header.set(enc.encode("0000000\0"), 116); // gid
    header.set(enc.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124); // size
    header.set(enc.encode("00000000000\0"), 136); // mtime
    header[156] = 0x30; // typeflag '0'
    header.set(enc.encode("ustar\0"), 257);
    header.set(enc.encode("00"), 263);
    // checksum: sum of bytes with the checksum field treated as spaces.
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let sum = 0;
    for (const b of header) sum += b;
    header.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(header);
    // data padded to 512.
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks = end
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) { out.set(b, off); off += b.length; }
  return out;
}

describe("tar.gz ingest", () => {
  it("detects gzip magic", () => {
    expect(isGzip(gzipSync(new Uint8Array([1, 2, 3])))).toBe(true);
    expect(isGzip(new Uint8Array([0x50, 0x4b]))).toBe(false); // zip 'PK'
  });

  it("parses a plain tar into files", () => {
    const tar = buildTar([
      { name: "pack.mcmeta", data: "{}" },
      { name: "assets/minecraft/textures/a.png", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const files = parseTar(tar);
    expect(files.map((f) => f.name)).toEqual([
      "pack.mcmeta",
      "assets/minecraft/textures/a.png",
    ]);
    expect([...files[1]!.data]).toEqual([1, 2, 3, 4]);
  });

  it("reads a gzipped tar into a VirtualFs", () => {
    const gz = gzipSync(buildTar([{ name: "pack.mcmeta", data: '{"pack":{"pack_format":46}}' }]));
    const { vfs, failed } = readTarGzDetailed(gz);
    expect(failed).toHaveLength(0);
    expect(vfs.readText("pack.mcmeta")).toContain("pack_format");
  });

  it("converts a pack delivered as .tar.gz end to end", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG sig (decoder tolerates; item just needs the file)
    ]);
    const tar = buildTar([
      { name: "pack.mcmeta", data: JSON.stringify({ pack: { pack_format: 15 } }) },
      { name: "assets/minecraft/textures/block/stone.png", data: png },
    ]);
    const gz = gzipSync(tar);
    // convertPack routes gzip → tar automatically via readZipDetailed.
    const result = await convertPack(gz, { packName: "TarPack" });
    expect(result.mcpack.length).toBeGreaterThan(0);
    expect(result.report.summary.error).toBe(0);
  });
});
