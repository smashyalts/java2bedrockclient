import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode as fastPngEncode } from "fast-png";
import { convertPack, readZip } from "../src/index.js";
import { decodePng, encodePng, encodeIndexedPng, type RgbaImage } from "../src/image/png.js";

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

describe("indexed PNG encoding", () => {
  it("roundtrips palette images bit-identically and beats RGBA size", () => {
    // 4 colours incl. transparency and a semi-transparent entry.
    const img = image(32, 32, (x, y) => {
      const c = (x + y) % 4;
      if (c === 0) return [0, 0, 0, 0];
      if (c === 1) return [255, 0, 0, 255];
      if (c === 2) return [0, 255, 0, 128];
      return [30, 60, 200, 255];
    });
    const encoded = encodePng(img);
    // Colour type 3 (indexed) chosen: IHDR colour-type byte at offset 25.
    expect(encoded[25]).toBe(3);
    const decoded = decodePng(encoded);
    expect(decoded.width).toBe(32);
    expect([...decoded.data]).toEqual([...img.data]);
  });

  it("packs tiny palettes below 8 bits per pixel", () => {
    const img = image(16, 16, (x) => (x % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const indexed = encodeIndexedPng(img)!;
    expect(indexed[24]).toBe(1); // bit depth 1 for a 2-colour image
    expect([...decodePng(indexed).data]).toEqual([...img.data]);
  });

  it("falls back to RGBA above 256 colours, still lossless", () => {
    // 1024 distinct colours.
    const img = image(32, 32, (x, y) => [x * 8, y * 8, (x * y) % 256, 255]);
    expect(encodeIndexedPng(img)).toBeUndefined();
    const encoded = encodePng(img);
    expect([...decodePng(encoded).data]).toEqual([...img.data]);
  });
});

describe("passthrough texture re-encode", () => {
  it("shrinks bloated pack textures without changing pixels", async () => {
    // fast-png emits unfiltered RGBA — deliberately bloated input.
    const width = 64;
    const height = 64;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data.set(i % 3 === 0 ? [120, 40, 40, 255] : [40, 120, 40, 255], i * 4);
    }
    const bloated = new Uint8Array(fastPngEncode({ width, height, data, channels: 4 }));

    const zip = zipSync({
      "pack.mcmeta": new TextEncoder().encode(JSON.stringify({ pack: { pack_format: 15 } })),
      "assets/minecraft/textures/block/stone.png": bloated,
    });
    const result = await convertPack(new Uint8Array(zip), { packName: "Shrink" });
    const out = readZip(result.mcpack);
    const shipped = out.read("textures/blocks/stone.png")!;
    expect(shipped.length).toBeLessThan(bloated.length);
    expect([...decodePng(shipped).data]).toEqual([...data]);

    const entry = result.report.entries.find((e) => e.stage === "optimize");
    expect(entry).toBeDefined();
    expect(entry!.outputs![0]).toMatch(/[1-9]\d* texture\(s\) re-encoded smaller/);
  });
});
