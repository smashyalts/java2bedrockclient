import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { decodePng } from "../src/image/png.js";
import { convertPack, readZip } from "../src/index.js";

function png(width = 16, height = 16): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(128);
  return new Uint8Array(encode({ width, height, data, channels: 4 }));
}

function fixtureZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(tree);
}

describe("aux stages", () => {
  it("converts block flipbook animations", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/textures/block/magma.png": png(16, 64),
      "assets/minecraft/textures/block/magma.png.mcmeta": JSON.stringify({
        animation: { frametime: 8, interpolate: true },
      }),
    });
    const out = readZip((await convertPack(zip, { packName: "Anim" })).mcpack);
    const flipbooks = JSON.parse(out.readText("textures/flipbook_textures.json")!);
    expect(flipbooks).toHaveLength(1);
    expect(flipbooks[0]).toMatchObject({
      flipbook_texture: "textures/blocks/magma",
      atlas_tile: "magma",
      ticks_per_frame: 8,
      blend_frames: true,
    });
  });

  it("converts sounds.json and copies oggs", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/sounds.json": JSON.stringify({
        "magic.zap": { category: "player", sounds: ["magic/zap", { name: "magic/zap2", volume: 0.5 }] },
      }),
      "assets/custom/sounds/magic/zap.ogg": new Uint8Array([1, 2, 3]),
      "assets/custom/sounds/magic/zap2.ogg": new Uint8Array([4, 5, 6]),
    });
    const out = readZip((await convertPack(zip, { packName: "Sounds" })).mcpack);
    expect(out.has("sounds/custom/magic/zap.ogg")).toBe(true);
    const defs = JSON.parse(out.readText("sounds/sound_definitions.json")!);
    const event = defs.sound_definitions["custom:magic.zap"];
    expect(event.category).toBe("player");
    expect(event.sounds[0].name).toBe("sounds/custom/magic/zap");
    expect(event.sounds[1]).toMatchObject({ name: "sounds/custom/magic/zap2", volume: 0.5 });
  });

  it("converts lang files with locale casing", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/lang/en_us.json": JSON.stringify({ "item.custom.ruby": "Ruby" }),
      "assets/other/lang/en_us.json": JSON.stringify({ "item.other.gem": "Gem" }),
    });
    const out = readZip((await convertPack(zip, { packName: "Lang" })).mcpack);
    const lang = out.readText("texts/en_US.lang")!;
    expect(lang).toContain("item.custom.ruby=Ruby");
    expect(lang).toContain("item.other.gem=Gem");
    expect(JSON.parse(out.readText("texts/languages.json")!)).toEqual(["en_US"]);
  });

  it("places bitmap font glyphs into glyph pages", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/font/default.json": JSON.stringify({
        providers: [
          { type: "bitmap", file: "custom:font/icons.png", height: 8, ascent: 7, chars: [""] },
        ],
      }),
      "assets/custom/textures/font/icons.png": png(16, 8),
    });
    const out = readZip((await convertPack(zip, { packName: "Fonts" })).mcpack);
    expect(out.has("font/glyph_E0.png")).toBe(true);
  });

  it("bakes the Java ascent into each glyph's vertical position in its cell", async () => {
    // Two glyphs on the same page with different ascents. The page's highest
    // ascent (10) sits flush to the top of its cell; the lower one (2) must be
    // pushed down by the 8-unit difference so their relative alignment holds.
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/font/default.json": JSON.stringify({
        providers: [
          { type: "bitmap", file: "custom:font/high.png", height: 8, ascent: 10, chars: [""] },
          { type: "bitmap", file: "custom:font/low.png", height: 8, ascent: 2, chars: [""] },
        ],
      }),
      "assets/custom/textures/font/high.png": png(8, 8),
      "assets/custom/textures/font/low.png": png(8, 8),
    });
    const out = readZip((await convertPack(zip, { packName: "Ascent" })).mcpack);
    // decodePng normalises to RGBA (the sheet may ship indexed/grayscale).
    const sheet = decodePng(out.read("font/glyph_E0.png")!);
    const cell = sheet.width / 16;
    const firstOpaqueRow = (cellX: number): number => {
      for (let y = 0; y < cell; y++) {
        for (let x = cellX; x < cellX + cell; x++) {
          if (sheet.data[(y * sheet.width + x) * 4 + 3]! > 0) return y;
        }
      }
      return -1;
    };
    // Glyph 0 (ascent 10) anchored at the top of its cell; glyph 1 (ascent 2)
    // dropped by 10 - 2 = 8 rows.
    expect(firstOpaqueRow(0)).toBe(0);
    expect(firstOpaqueRow(cell)).toBe(8);
  });

  it("drops glyphs hidden in Java by an off-screen ascent instead of showing them", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/font/default.json": JSON.stringify({
        providers: [
          { type: "bitmap", file: "custom:font/icons.png", height: 8, ascent: 7, chars: [""] },
          // The "hide it off-screen" trick — Bedrock can't offset this far.
          { type: "bitmap", file: "custom:font/blank.png", height: -10, ascent: -42069, chars: [""] },
        ],
      }),
      "assets/custom/textures/font/icons.png": png(8, 8),
      "assets/custom/textures/font/blank.png": png(8, 8),
    });
    const result = await convertPack(zip, { packName: "Hidden" });
    const skipped = result.report.entries.find(
      (e) => e.stage === "fonts" && e.status === "skipped" && /off-screen ascent/.test(e.detail ?? ""),
    );
    expect(skipped).toBeDefined();
    // The visible glyph still converts.
    expect(readZip(result.mcpack).has("font/glyph_E0.png")).toBe(true);
  });

  it("stitches paintings into kz.png", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/textures/painting/kebab.png": png(16, 16),
      "assets/minecraft/textures/painting/pointer.png": png(64, 64),
    });
    const result = await convertPack(zip, { packName: "Paint" });
    const out = readZip(result.mcpack);
    expect(out.has("textures/painting/kz.png")).toBe(true);
    // partial atlas warning
    expect(
      result.report.entries.some((e) => e.stage === "paintings" && e.status === "approximated"),
    ).toBe(true);
  });
});
