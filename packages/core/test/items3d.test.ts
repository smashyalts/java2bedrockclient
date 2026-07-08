import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { convertPack, readZip } from "../src/index.js";

function png(width = 16, height = 16, rgba: [number, number, number, number] = [255, 0, 0, 255]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return new Uint8Array(encode({ width, height, data, channels: 4 }));
}

function fixtureZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(tree);
}

const SWORD_MODEL = {
  textures: { blade: "custom:item/blade", handle: "custom:item/handle", particle: "custom:item/blade" },
  elements: [
    {
      from: [7, 0, 7],
      to: [9, 16, 9],
      faces: {
        north: { uv: [0, 0, 2, 16], texture: "#blade" },
        south: { uv: [0, 0, 2, 16], texture: "#blade" },
        east: { uv: [2, 0, 4, 16], texture: "#blade" },
        west: { uv: [2, 0, 4, 16], texture: "#blade" },
        up: { uv: [0, 0, 2, 2], texture: "#handle" },
        down: { uv: [0, 0, 2, 2], texture: "#handle" },
      },
      rotation: { origin: [8, 8, 8], axis: "y", angle: 45 },
    },
  ],
  display: {
    thirdperson_righthand: { rotation: [0, 90, 0], translation: [1, 2, 3], scale: [1.5, 1.5, 1.5] },
  },
};

describe("3D custom items", () => {
  it("emits geometry, attachable, animations, atlas and mapping", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/diamond_sword.json": JSON.stringify({
        parent: "minecraft:item/handheld",
        textures: { layer0: "minecraft:item/diamond_sword" },
        overrides: [{ predicate: { custom_model_data: 10 }, model: "custom:item/big_sword" }],
      }),
      "assets/custom/models/item/big_sword.json": JSON.stringify(SWORD_MODEL),
      "assets/custom/textures/item/blade.png": png(16, 16, [200, 20, 20, 255]),
      "assets/custom/textures/item/handle.png": png(16, 16, [90, 60, 20, 255]),
    });

    const result = await convertPack(zip, { packName: "Swords" });
    const out = readZip(result.mcpack);

    expect(out.has("models/entity/geyser_custom/custom_item_big_sword.geo.json")).toBe(true);
    expect(out.has("attachables/geyser_custom/custom_item_big_sword.json")).toBe(true);
    expect(out.has("animations/geyser_custom/custom_item_big_sword.animation.json")).toBe(true);
    expect(out.has("textures/geyser_custom/atlases/custom_item_big_sword.png")).toBe(true);

    const geo = JSON.parse(out.readText("models/entity/geyser_custom/custom_item_big_sword.geo.json")!);
    const desc = geo["minecraft:geometry"][0].description;
    expect(desc.identifier).toBe("geometry.geyser_custom.custom_item_big_sword");
    // 2 textures, grid 2x2 wait ceil(sqrt(2)) = 2 columns, 1 row → 32x16
    expect(desc.texture_width).toBe(32);
    expect(desc.texture_height).toBe(16);

    const bones = geo["minecraft:geometry"][0].bones;
    expect(bones.map((b: { name: string }) => b.name)).toEqual([
      "geysercmd",
      "geysercmd_x",
      "geysercmd_y",
      "geysercmd_z",
    ]);
    const cube = bones[3].cubes[0];
    // origin = [8 - to_x, from_y, from_z - 8] = [8-9, 0, 7-8]
    expect(cube.origin).toEqual([-1, 0, -1]);
    expect(cube.size).toEqual([2, 16, 2]);
    // y-axis rotation → [0, -45, 0], pivot [8-8, 8, 8-8]
    expect(cube.rotation).toEqual([0, -45, 0]);
    expect(cube.pivot).toEqual([0, 8, 8 - 8]);

    const anims = JSON.parse(out.readText("animations/geyser_custom/custom_item_big_sword.animation.json")!);
    const tp = anims.animations["animation.geyser_custom.custom_item_big_sword.thirdperson_main_hand"];
    expect(tp.bones.geysercmd.rotation).toEqual([90, 0, 0]);
    // base [0,13,-3] + [-tx, ty, tz] = [-1, 15, 0]
    expect(tp.bones.geysercmd.position).toEqual([-1, 15, 0]);
    expect(tp.bones.geysercmd_y.rotation).toEqual([0, -90, 0]);
    expect(tp.bones.geysercmd_z.scale).toEqual([1.5, 1.5, 1.5]);

    const attachable = JSON.parse(out.readText("attachables/geyser_custom/custom_item_big_sword.json")!);
    expect(attachable["minecraft:attachable"].description.identifier).toBe(
      "geyser_custom:custom_item_big_sword",
    );

    const mappings = JSON.parse(result.geyserMappings!);
    const entry = mappings.items["minecraft:diamond_sword"][0];
    expect(entry).toMatchObject({
      type: "legacy",
      custom_model_data: 10,
      bedrock_identifier: "geyser_custom:custom_item_big_sword",
    });
    // icon registered
    expect(entry.bedrock_options.icon).toBe("custom_item_big_sword_icon");
  });
});
