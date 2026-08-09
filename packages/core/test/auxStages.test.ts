import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { decodePng, type RgbaImage } from "../src/image/png.js";
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

  it("never replaces Bedrock's ASCII sheet to honour a few decorative overrides", async () => {
    // ItemsAdder skins A/!/@ for its GUI titles. font/glyph_00.png replaces
    // Bedrock's whole Latin-1 sheet, so emitting it for three glyphs would
    // blank every other letter, digit and punctuation mark in the game.
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/font/gui.json": JSON.stringify({
        providers: [
          { type: "bitmap", file: "custom:font/a.png", height: 8, ascent: 7, chars: ["A"] },
          { type: "bitmap", file: "custom:font/at.png", height: 8, ascent: 7, chars: ["@"] },
        ],
      }),
      "assets/custom/textures/font/a.png": png(8, 8),
      "assets/custom/textures/font/at.png": png(8, 8),
    });
    const result = await convertPack(zip, { packName: "Ascii" });
    expect(readZip(result.mcpack).has("font/glyph_00.png")).toBe(false);
    expect(
      result.report.entries.some((e) => e.detail?.includes("blank every character")),
    ).toBe(true);
  });

  it("renders glyphs of equal Java height at equal size, whatever their source resolution", async () => {
    // Java scales a provider's texture to its `height`, so these two render
    // identically in game despite one shipping 8x the pixels. Bedrock has no
    // height metric — size comes from how much of its cell the art covers — so
    // blitting source pixels made the small one 8x smaller than the large one.
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/font/default.json": JSON.stringify({
        providers: [
          { type: "bitmap", file: "custom:font/small.png", height: 9, ascent: 8, chars: [""] },
          { type: "bitmap", file: "custom:font/large.png", height: 9, ascent: 8, chars: [""] },
        ],
      }),
      "assets/custom/textures/font/small.png": png(8, 8),
      "assets/custom/textures/font/large.png": png(64, 64),
    });
    const sheet = decodePng(
      readZip((await convertPack(zip, { packName: "Heights" })).mcpack).read("font/glyph_E0.png")!,
    );
    const cell = sheet.width / 16;
    expect(opaqueRows(sheet, cell, 0)).toEqual(opaqueRows(sheet, cell, cell));
    // ...and each actually covers a usable share of its cell, not a few pixels.
    const [top, bottom] = opaqueRows(sheet, cell, 0);
    expect((bottom - top + 1) / cell).toBeGreaterThan(0.5);
  });

  it("keeps a wide glyph's aspect ratio instead of squashing it into the square cell", async () => {
    // A 256x64 server banner. Bedrock cells are square and a glyph can't spill
    // into its neighbour, so scaling to the declared height and clamping the
    // width separately drew a 4:1 banner as a square.
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/font/default.json": JSON.stringify({
        providers: [
          { type: "bitmap", file: "custom:font/banner.png", height: 32, ascent: 16, chars: [""] },
          { type: "bitmap", file: "custom:font/icon.png", height: 9, ascent: 8, chars: [""] },
        ],
      }),
      "assets/custom/textures/font/banner.png": png(256, 64),
      "assets/custom/textures/font/icon.png": png(16, 16),
    });
    const sheet = decodePng(
      readZip((await convertPack(zip, { packName: "Wide" })).mcpack).read("font/glyph_E0.png")!,
    );
    const cell = sheet.width / 16;
    const [top, bottom] = opaqueRows(sheet, cell, 0);
    const drawn = bottom - top + 1;
    // 256x64 is 4:1, and width binds, so it fills the cell across and a
    // quarter of it down. Allow a pixel of rounding either way.
    expect(drawn).toBeGreaterThanOrEqual(Math.floor(cell / 4) - 1);
    expect(drawn).toBeLessThanOrEqual(Math.ceil(cell / 4) + 1);
  });

  it("places a lower-ascent glyph below a higher-ascent one in its cell", async () => {
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
    const sheet = decodePng(
      readZip((await convertPack(zip, { packName: "Ascent" })).mcpack).read("font/glyph_E0.png")!,
    );
    const cell = sheet.width / 16;
    // The page's highest ascent anchors to the top; the lower one sits under it.
    expect(opaqueRows(sheet, cell, 0)[0]).toBe(0);
    expect(opaqueRows(sheet, cell, cell)[0]).toBeGreaterThan(0);
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

/** First and last rows holding an opaque pixel inside the cell starting at `cellX`. */
function opaqueRows(sheet: RgbaImage, cell: number, cellX: number): [number, number] {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < cell; y++) {
    for (let x = cellX; x < cellX + cell; x++) {
      if (sheet.data[(y * sheet.width + x) * 4 + 3]! === 0) continue;
      if (top === -1) top = y;
      bottom = y;
      break;
    }
  }
  return [top, bottom];
}
