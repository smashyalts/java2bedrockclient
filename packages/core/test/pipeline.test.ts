import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { convertPack, readZip } from "../src/index.js";

/** 1x1 transparent PNG. */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function fixtureZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(tree);
}

describe("convertPack", () => {
  it("converts a minimal pack: manifest, renamed + passthrough textures", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 34, description: "Test pack" } }),
      "pack.png": TINY_PNG,
      "assets/minecraft/textures/block/oak_log.png": TINY_PNG,
      "assets/minecraft/textures/block/barrel_top.png": TINY_PNG,
      "assets/minecraft/textures/item/golden_apple.png": TINY_PNG,
      "assets/custom/textures/item/ruby.png": TINY_PNG,
    });

    const result = await convertPack(zip, { packName: "Test" });
    const out = readZip(result.mcpack);

    expect(out.has("manifest.json")).toBe(true);
    expect(out.has("pack_icon.png")).toBe(true);
    // explicit rename
    expect(out.has("textures/blocks/log_oak.png")).toBe(true);
    // passthrough (modern parity name)
    expect(out.has("textures/blocks/barrel_top.png")).toBe(true);
    expect(out.has("textures/items/apple_golden.png")).toBe(true);
    // custom namespace preserved
    expect(out.has("textures/custom/item/ruby.png")).toBe(true);

    const manifest = JSON.parse(out.readText("manifest.json")!);
    expect(manifest.header.name).toBe("Test");
    expect(manifest.header.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    expect(result.report.summary.error).toBe(0);
    expect(result.report.summary.converted).toBeGreaterThanOrEqual(3);
  });

  it("handles packs nested one folder deep", async () => {
    const zip = fixtureZip({
      "MyPack/pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "MyPack/assets/minecraft/textures/block/granite.png": TINY_PNG,
    });
    const result = await convertPack(zip, { packName: "Nested" });
    const out = readZip(result.mcpack);
    expect(out.has("textures/blocks/stone_granite.png")).toBe(true);
  });

  it("produces deterministic manifest UUIDs per pack name", async () => {
    const zip = fixtureZip({ "pack.mcmeta": "{}" });
    const a = await convertPack(zip, { packName: "Same" });
    const b = await convertPack(zip, { packName: "Same" });
    const uuidA = JSON.parse(readZip(a.mcpack).readText("manifest.json")!).header.uuid;
    const uuidB = JSON.parse(readZip(b.mcpack).readText("manifest.json")!).header.uuid;
    expect(uuidA).toBe(uuidB);
  });
});
