import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { convertPack, readZip } from "../src/index.js";

function png(width = 16, height = 16): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(120);
  return new Uint8Array(encode({ width, height, data, channels: 4 }));
}

function fixtureZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(tree);
}

describe("custom blocks", () => {
  it("converts note_block state overrides into Geyser block mappings v1", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/blockstates/note_block.json": JSON.stringify({
        variants: {
          "instrument=hat,note=0,powered=false": { model: "oraxen:block/ruby_block" },
          "instrument=hat,note=1,powered=false": { model: "oraxen:block/ruby_lamp" },
          // vanilla default — model not shipped in pack, must be ignored
          "instrument=harp,note=0,powered=false": { model: "minecraft:block/note_block" },
        },
      }),
      "assets/oraxen/models/block/ruby_block.json": JSON.stringify({
        parent: "minecraft:block/cube_all",
        textures: { all: "oraxen:block/ruby" },
      }),
      "assets/oraxen/models/block/ruby_lamp.json": JSON.stringify({
        parent: "minecraft:block/cube_bottom_top",
        textures: { side: "oraxen:block/ruby", top: "oraxen:block/ruby_top", bottom: "oraxen:block/ruby" },
      }),
      "assets/oraxen/textures/block/ruby.png": png(),
      "assets/oraxen/textures/block/ruby_top.png": png(),
    });

    const result = await convertPack(zip, { packName: "Blocks" });
    expect(result.geyserBlockMappings).toBeDefined();
    const blocks = JSON.parse(result.geyserBlockMappings!);
    expect(blocks.format_version).toBe(1);

    const noteBlock = blocks.blocks["minecraft:note_block"];
    expect(noteBlock.only_override_states).toBe(true);
    const overrides = noteBlock.state_overrides;
    expect(Object.keys(overrides)).toHaveLength(2);

    const rubyBlock = overrides["instrument=hat,note=0,powered=false"];
    expect(rubyBlock.geometry).toEqual({ identifier: "minecraft:geometry.full_block" });
    expect(rubyBlock.material_instances["*"].texture).toBe("gcb_oraxen_block_ruby");

    const rubyLamp = overrides["instrument=hat,note=1,powered=false"];
    expect(rubyLamp.material_instances["up"].texture).toBe("gcb_oraxen_block_ruby_top");
    expect(rubyLamp.material_instances["north"].texture).toBe("gcb_oraxen_block_ruby");

    // Bedrock pack side: terrain_texture + copied textures.
    const out = readZip(result.mcpack);
    const terrain = JSON.parse(out.readText("textures/terrain_texture.json")!);
    expect(terrain.texture_data["gcb_oraxen_block_ruby"].textures).toBe(
      "textures/geyser_custom/blocks/oraxen_block_ruby",
    );
    expect(out.has("textures/geyser_custom/blocks/oraxen_block_ruby.png")).toBe(true);
  });

  it("converts non-cube block models to custom geometry", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/blockstates/tripwire.json": JSON.stringify({
        variants: {
          "attached=false,disarmed=false,east=false,north=false,powered=false,south=false,west=false": {
            model: "oraxen:block/small_pot",
          },
        },
      }),
      "assets/oraxen/models/block/small_pot.json": JSON.stringify({
        textures: { particle: "oraxen:block/pot", pot: "oraxen:block/pot" },
        elements: [
          {
            from: [5, 0, 5],
            to: [11, 6, 11],
            faces: {
              north: { uv: [0, 0, 6, 6], texture: "#pot" },
              south: { uv: [0, 0, 6, 6], texture: "#pot" },
              east: { uv: [0, 0, 6, 6], texture: "#pot" },
              west: { uv: [0, 0, 6, 6], texture: "#pot" },
              up: { uv: [0, 0, 6, 6], texture: "#pot" },
            },
          },
        ],
      }),
      "assets/oraxen/textures/block/pot.png": png(),
    });

    const result = await convertPack(zip, { packName: "Pots" });
    const blocks = JSON.parse(result.geyserBlockMappings!);
    const override = Object.values(
      blocks.blocks["minecraft:tripwire"].state_overrides,
    )[0] as { geometry: { identifier: string } };
    expect(override.geometry.identifier).toBe("geometry.geyser_custom.block_oraxen_block_small_pot");
    const out = readZip(result.mcpack);
    expect(out.has("models/blocks/geyser_custom/oraxen_block_small_pot.geo.json")).toBe(true);
    expect(out.has("textures/geyser_custom/blocks/oraxen_block_small_pot.png")).toBe(true);
  });
});
