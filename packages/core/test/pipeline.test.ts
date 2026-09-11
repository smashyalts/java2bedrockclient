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
    // Unreferenced custom-namespace textures are swept by the optimizer's
    // dead-file elimination — no model, mapping, or JSON points at ruby, so
    // Bedrock could never load it.
    expect(out.has("textures/custom/item/ruby.png")).toBe(false);

    const manifest = JSON.parse(out.readText("manifest.json")!);
    expect(manifest.header.name).toBe("Test");
    expect(manifest.header.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    expect(result.report.summary.error).toBe(0);
    expect(result.report.summary.converted).toBeGreaterThanOrEqual(3);

    // Timings are populated: every stage recorded, total is their sum.
    expect(result.timings.stages.length).toBeGreaterThan(0);
    expect(result.timings.stages.some((s) => s.name === "packaging")).toBe(true);
    expect(result.timings.stages.some((s) => s.name === "zip.write")).toBe(true);
    const sum = result.timings.stages.reduce((n, s) => n + s.ms, 0);
    expect(result.timings.totalMs).toBe(Math.round(sum));
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
  it("fails loudly on an upload it cannot read, instead of shipping an empty pack", async () => {
    // Merging turned a thrown read error into a caught one, which let a corrupt
    // or renamed archive sail through every stage and hand the user a
    // downloadable pack containing nothing.
    await expect(convertPack(new Uint8Array([1, 2, 3, 4]), { packName: "x" })).rejects.toThrow(
      /Nothing to convert/,
    );
  });

  it("finds the pack root by its assets tree when nothing carries a pack.mcmeta", async () => {
    // A plugin's working directory (Nexo's `pack/`) keeps its mcmeta inside the
    // generated zip beside it, so the assets tree is the only marker. Without
    // this every path stays a level too deep and the run silently converts
    // nothing.
    const zip = fixtureZip({
      "pack/pack.zip": "not a pack we read",
      "pack/assets/minecraft/textures/item/apple.png": TINY_PNG,
      "pack/external_packs/other/assets/minecraft/textures/item/pear.png": TINY_PNG,
    });
    const result = await convertPack(zip, { packName: "Nested" });
    const out = readZip(result.mcpack);
    expect(out.has("textures/items/apple.png")).toBe(true);
  });

  it("rejects an upload that is neither a pack nor contains one", async () => {
    const zip = fixtureZip({ "config/items.yml": "sword: { material: PAPER }" });
    await expect(convertPack(zip, { packName: "x", packNames: ["configs.zip"] })).rejects.toThrow(
      /no assets folder and no pack\.mcmeta/,
    );
  });

  it("merges two packs, keeping each one's assets and the first one's contested file", async () => {
    const a = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 34, description: "A" } }),
      "assets/minecraft/textures/item/apple.png": TINY_PNG,
      "assets/shared/textures/item/contested.png": TINY_PNG,
    });
    const b = fixtureZip({
      // Zipped from its containing folder — the common packaging mistake.
      "Inner/pack.mcmeta": JSON.stringify({ pack: { pack_format: 34, description: "B" } }),
      "Inner/assets/minecraft/textures/item/stick.png": TINY_PNG,
      "Inner/assets/shared/textures/item/contested.png": new Uint8Array([...TINY_PNG, 0]),
    });
    const result = await convertPack([a, b], { packName: "merged", packNames: ["a", "b"], optimizePack: false });
    const merged = result.report.entries.filter((e) => e.stage === "merge");
    expect(merged.some((e) => e.source === "2 resource packs merged")).toBe(true);
    // The nested pack's root was normalised, so its texture came through.
    const out = readZip(result.mcpack);
    expect(out.list({ suffix: ".png" }).some((p) => p.includes("stick"))).toBe(true);
    expect(out.list({ suffix: ".png" }).some((p) => p.includes("apple"))).toBe(true);
    expect(merged.some((e) => e.source.includes("contested"))).toBe(true);
  });
});
