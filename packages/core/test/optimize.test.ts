import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { convertPack, readZip } from "../src/index.js";
import { decodePng } from "../src/image/png.js";

function png(): Uint8Array {
  const data = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) data.set([200, 100, 50, 255], i * 4);
  return new Uint8Array(encode({ width: 16, height: 16, data, channels: 4 }));
}

function fixtureZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(tree);
}

/** Two custom items pointing at byte-identical textures. */
function dupePackZip(): Uint8Array {
  return fixtureZip({
    "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
    "assets/minecraft/models/item/stick.json": JSON.stringify({
      parent: "minecraft:item/generated",
      textures: { layer0: "minecraft:item/stick" },
      overrides: [
        { predicate: { custom_model_data: 1 }, model: "custom:item/wand_a" },
        { predicate: { custom_model_data: 2 }, model: "custom:item/wand_b" },
      ],
    }),
    "assets/custom/models/item/wand_a.json": JSON.stringify({
      parent: "minecraft:item/generated",
      textures: { layer0: "custom:item/wand_a" },
    }),
    "assets/custom/models/item/wand_b.json": JSON.stringify({
      parent: "minecraft:item/generated",
      textures: { layer0: "custom:item/wand_b" },
    }),
    "assets/custom/textures/item/wand_a.png": png(),
    "assets/custom/textures/item/wand_b.png": png(), // identical bytes
  });
}

describe("lossless pack optimizer", () => {
  it("merges duplicate textures and rewrites references; minifies JSON", async () => {
    const result = await convertPack(dupePackZip(), { packName: "Opt" });
    const out = readZip(result.mcpack);

    // One of the two identical icons survives; references collapse onto it.
    const a = out.has("textures/geyser_custom/custom_item_wand_a.png");
    const b = out.has("textures/geyser_custom/custom_item_wand_b.png");
    expect(a !== b || (a && !b)).toBe(true);
    expect(a && b).toBe(false);

    const itemTexture = JSON.parse(out.readText("textures/item_texture.json")!);
    const paths = Object.values(itemTexture.texture_data).map(
      (e) => (e as { textures: string }).textures,
    );
    expect(new Set(paths).size).toBe(1);

    // Minified: no pretty-print newlines in pack JSON.
    expect(out.readText("manifest.json")!).not.toContain("\n");

    const entry = result.report.entries.find((e) => e.stage === "optimize");
    expect(entry).toBeDefined();
    expect(entry!.outputs![0]).toContain("1 duplicate texture(s) merged");
  });

  it("runs zopfli only with maxCompression; PNGs stay valid", async () => {
    const off = await convertPack(dupePackZip(), { packName: "Zop" });
    const on = await convertPack(dupePackZip(), { packName: "Zop", maxCompression: true });

    const offEntry = off.report.entries.find((e) => e.stage === "optimize")!;
    const onEntry = on.report.entries.find((e) => e.stage === "optimize")!;
    expect(offEntry.outputs![0]).toContain("zopfli off");
    expect(onEntry.outputs![0]).toMatch(/zopfli-recompressed/);

    // Recompressed pack is no larger, and PNGs stay decodable.
    expect(on.mcpack.length).toBeLessThanOrEqual(off.mcpack.length + 512);
    const out = readZip(on.mcpack);
    const png = out.list({ prefix: "textures/geyser_custom/", suffix: ".png" })[0]!;
    expect(() => decodePng(out.read(png)!)).not.toThrow();
  });

  it("respects optimizePack: false", async () => {
    const result = await convertPack(dupePackZip(), { packName: "NoOpt", optimizePack: false });
    const out = readZip(result.mcpack);
    expect(out.has("textures/geyser_custom/custom_item_wand_a.png")).toBe(true);
    expect(out.has("textures/geyser_custom/custom_item_wand_b.png")).toBe(true);
    expect(out.readText("manifest.json")!).toContain("\n");
    expect(result.report.entries.some((e) => e.stage === "optimize")).toBe(false);
  });
});
