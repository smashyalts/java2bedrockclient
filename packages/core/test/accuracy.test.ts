import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { convertPack, readZip } from "../src/index.js";

function png(width = 16, height = 16): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(150);
  return new Uint8Array(encode({ width, height, data, channels: 4 }));
}

function fixtureZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(tree);
}

describe("accuracy improvements", () => {
  it("converts block models with vanilla parents via the builtin library", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/stick.json": JSON.stringify({
        parent: "minecraft:item/handheld",
        textures: { layer0: "minecraft:item/stick" },
        overrides: [{ predicate: { custom_model_data: 1 }, model: "custom:block/ruby_block" }],
      }),
      "assets/custom/models/block/ruby_block.json": JSON.stringify({
        parent: "minecraft:block/cube_all",
        textures: { all: "custom:block/ruby" },
      }),
      "assets/custom/textures/block/ruby.png": png(),
    });

    const result = await convertPack(zip, { packName: "Blocks" });
    const out = readZip(result.mcpack);
    // Previously "unclassifiable" — now a full 3D geometry conversion.
    const geoPath = "models/entity/geyser_custom/custom_block_ruby_block.geo.json";
    expect(out.has(geoPath)).toBe(true);
    const geo = JSON.parse(out.readText(geoPath)!);
    const cube = geo["minecraft:geometry"][0].bones[3].cubes[0];
    expect(cube.origin).toEqual([-8, 0, -8]);
    expect(cube.size).toEqual([16, 16, 16]);
    // All six faces textured from #all.
    expect(Object.keys(cube.uv).sort()).toEqual(["down", "east", "north", "south", "up", "west"]);

    // block/block display transforms applied (gui/thirdperson from vanilla).
    const anims = JSON.parse(
      out.readText("animations/geyser_custom/custom_block_ruby_block.animation.json")!,
    );
    const tp = anims.animations["animation.geyser_custom.custom_block_ruby_block.thirdperson_main_hand"];
    // java thirdperson_righthand rotation [75,45,0] → x/y negated on split bones
    expect(tp.bones.geysercmd_x.rotation).toEqual([-75, 0, 0]);
    expect(tp.bones.geysercmd_y.rotation).toEqual([0, -45, 0]);
    expect(tp.bones.geysercmd_z.scale).toEqual([0.375, 0.375, 0.375]);
  });

  it("bakes rescale into cube coordinates (cross models)", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/stick.json": JSON.stringify({
        parent: "minecraft:item/handheld",
        textures: { layer0: "minecraft:item/stick" },
        overrides: [{ predicate: { custom_model_data: 1 }, model: "custom:block/flower" }],
      }),
      "assets/custom/models/block/flower.json": JSON.stringify({
        parent: "minecraft:block/cross",
        textures: { cross: "custom:block/flower" },
      }),
      "assets/custom/textures/block/flower.png": png(),
    });
    const out = readZip((await convertPack(zip, { packName: "Cross" })).mcpack);
    const geo = JSON.parse(out.readText("models/entity/geyser_custom/custom_block_flower.geo.json")!);
    const cube = geo["minecraft:geometry"][0].bones[3].cubes[0];
    // from.x 0.8 → 8 + (0.8-8)/cos45° ≈ -2.182; size.x = 14.4 * √2 ≈ 20.365
    expect(cube.size[0]).toBeCloseTo(14.4 * Math.SQRT2, 3);
    expect(cube.size[1]).toBe(16); // rotation axis y untouched
  });

  it("armor attachables hide the matching skin layer", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/textures/models/armor/obsidian_layer_1.png": png(64, 32),
    });
    const out = readZip((await convertPack(zip, { packName: "ArmorFix" })).mcpack);
    const helmet = JSON.parse(out.readText("attachables/geyser_custom/armor/custom_obsidian_helmet.json")!);
    expect(helmet["minecraft:attachable"].description.scripts.parent_setup).toBe(
      "variable.helmet_layer_visible = 0.0;",
    );
    const boots = JSON.parse(out.readText("attachables/geyser_custom/armor/custom_obsidian_boots.json")!);
    expect(boots["minecraft:attachable"].description.scripts.parent_setup).toBe(
      "variable.boot_layer_visible = 0.0;",
    );
  });

  it("assigns ascending priority to range_dispatch thresholds", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/custom/items/gauge.json": JSON.stringify({
        model: {
          type: "minecraft:range_dispatch",
          property: "minecraft:custom_model_data",
          entries: [
            { threshold: 10, model: { type: "minecraft:model", model: "custom:item/gauge_high" } },
            { threshold: 1, model: { type: "minecraft:model", model: "custom:item/gauge_low" } },
          ],
          fallback: { type: "minecraft:model", model: "custom:item/gauge_empty" },
        },
      }),
      "assets/custom/models/item/gauge_low.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/gauge" },
      }),
      "assets/custom/models/item/gauge_high.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/gauge" },
      }),
      "assets/custom/models/item/gauge_empty.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/gauge" },
      }),
      "assets/custom/textures/item/gauge.png": png(),
    });
    const result = await convertPack(zip, { packName: "Priority" });
    const defs = JSON.parse(result.geyserMappings!).items["minecraft:paper"];
    const byModel = Object.fromEntries(
      defs.map((d: { bedrock_identifier: string; priority?: number }) => [d.bedrock_identifier, d.priority]),
    );
    // higher threshold → higher priority; fallback lowest
    expect(byModel["geyser_custom:custom_item_gauge_high"]).toBe(2);
    expect(byModel["geyser_custom:custom_item_gauge_low"]).toBe(1);
    expect(byModel["geyser_custom:custom_item_gauge_empty"]).toBe(0);
  });

  it("sizes visible bounds to the model extents", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/stick.json": JSON.stringify({
        parent: "minecraft:item/handheld",
        textures: { layer0: "minecraft:item/stick" },
        overrides: [{ predicate: { custom_model_data: 1 }, model: "custom:item/greatsword" }],
      }),
      "assets/custom/models/item/greatsword.json": JSON.stringify({
        textures: { a: "custom:item/blade" },
        elements: [
          {
            from: [-16, -8, 7],
            to: [32, 40, 9],
            faces: { north: { uv: [0, 0, 16, 16], texture: "#a" } },
          },
        ],
      }),
      "assets/custom/textures/item/blade.png": png(),
    });
    const out = readZip((await convertPack(zip, { packName: "Big" })).mcpack);
    const geo = JSON.parse(out.readText("models/entity/geyser_custom/custom_item_greatsword.geo.json")!);
    const desc = geo["minecraft:geometry"][0].description;
    // x spans [8-32, 8+16] = [-24, 24] → width ≥ 4 blocks; default 4 would clip.
    expect(desc.visible_bounds_width).toBeGreaterThanOrEqual(4);
    expect(desc.visible_bounds_height).toBeGreaterThanOrEqual(4.5);
  });

  it("converts blockstate x/y rotations to block transformations", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/blockstates/note_block.json": JSON.stringify({
        variants: {
          "instrument=hat,note=0,powered=false": { model: "oraxen:block/chair", y: 90 },
        },
      }),
      "assets/oraxen/models/block/chair.json": JSON.stringify({
        parent: "minecraft:block/cube_all",
        textures: { all: "oraxen:block/chair" },
      }),
      "assets/oraxen/textures/block/chair.png": png(),
    });
    const result = await convertPack(zip, { packName: "Rot" });
    const blocks = JSON.parse(result.geyserBlockMappings!);
    const override = blocks.blocks["minecraft:note_block"].state_overrides["instrument=hat,note=0,powered=false"];
    expect(override.transformation).toEqual({ rotation: [0, -90, 0] });
  });

  it("converts Java positional lang args to Bedrock syntax", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/lang/en_us.json": JSON.stringify({
        "msg.greet": "Hello %1$s, you have %2$d coins",
      }),
    });
    const out = readZip((await convertPack(zip, { packName: "Lang2" })).mcpack);
    expect(out.readText("texts/en_US.lang")).toContain("msg.greet=Hello %1, you have %2 coins");
  });

  it("uses config display names over filename guesses", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/oraxen/items/ruby_sword.json": JSON.stringify({
        model: { type: "minecraft:model", model: "oraxen:item/ruby_sword" },
      }),
      "assets/oraxen/models/item/ruby_sword.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "oraxen:item/ruby_sword" },
      }),
      "assets/oraxen/textures/item/ruby_sword.png": png(),
    });
    const result = await convertPack(zip, {
      packName: "Names",
      baseItemHints: { ruby_sword: "minecraft:diamond_sword" },
      displayNameHints: { ruby_sword: "The Crimson Blade" },
    });
    const defs = JSON.parse(result.geyserMappings!).items["minecraft:diamond_sword"];
    expect(defs[0].display_name).toBe("The Crimson Blade");
  });

  it("flags sound events referencing files missing from the pack", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/sounds.json": JSON.stringify({
        "magic.zap": { sounds: ["magic/zap"] },
      }),
    });
    const result = await convertPack(zip, { packName: "MissingSound" });
    expect(
      result.report.entries.some(
        (e) => e.stage === "sounds" && e.status === "approximated" && e.detail?.includes("custom:magic/zap"),
      ),
    ).toBe(true);
  });
});
