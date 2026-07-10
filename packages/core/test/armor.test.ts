import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { convertPack, readZip } from "../src/index.js";

function png(width = 64, height = 32): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(200);
  return new Uint8Array(encode({ width, height, data, channels: 4 }));
}

function fixtureZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(tree);
}

describe("custom armor", () => {
  it("renames vanilla armor layer textures", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/textures/models/armor/diamond_layer_1.png": png(),
      "assets/minecraft/textures/models/armor/chainmail_layer_2.png": png(),
      "assets/minecraft/textures/models/armor/leather_layer_1_overlay.png": png(),
    });
    const out = readZip((await convertPack(zip, { packName: "Vanilla" })).mcpack);
    expect(out.has("textures/models/armor/diamond_1.png")).toBe(true);
    expect(out.has("textures/models/armor/chain_2.png")).toBe(true);
    expect(out.has("textures/models/armor/leather_1_overlay.png")).toBe(true);
  });

  it("converts modern equipment assets into attachables bound to item mappings", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/custom/equipment/ruby.json": JSON.stringify({
        layers: {
          humanoid: [{ texture: "custom:ruby" }],
          humanoid_leggings: [{ texture: "custom:ruby" }],
        },
      }),
      "assets/custom/textures/entity/equipment/humanoid/ruby.png": png(),
      "assets/custom/textures/entity/equipment/humanoid_leggings/ruby.png": png(),
      "assets/custom/items/ruby_helmet.json": JSON.stringify({
        model: { type: "minecraft:model", model: "custom:item/ruby_helmet" },
      }),
      "assets/custom/models/item/ruby_helmet.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/ruby_helmet" },
      }),
      "assets/custom/textures/item/ruby_helmet.png": png(16, 16),
    });

    const result = await convertPack(zip, { packName: "Armor" });
    const out = readZip(result.mcpack);
    const mappings = JSON.parse(result.geyserMappings!);

    const defs = mappings.items["minecraft:paper"];
    // Identifier derives from the readable item-model id now.
    const helmet = defs.find(
      (d: { bedrock_identifier: string }) => d.bedrock_identifier === "geyser_custom:ruby_helmet",
    );
    expect(helmet).toBeDefined();
    expect(helmet.components["minecraft:equippable"]).toEqual({ slot: "head" });

    // Attachable emitted under the item's identifier.
    const attachablePath = "attachables/geyser_custom/armor/geyser_custom_ruby_helmet.json";
    expect(out.has(attachablePath)).toBe(true);
    const attachable = JSON.parse(out.readText(attachablePath)!);
    expect(attachable["minecraft:attachable"].description.identifier).toBe(
      "geyser_custom:ruby_helmet",
    );
    expect(attachable["minecraft:attachable"].description.geometry.default).toBe(
      "geometry.player.armor.helmet",
    );

    // Unmatched pieces get standalone attachables.
    expect(out.has("attachables/geyser_custom/armor/custom_ruby_chestplate.json")).toBe(true);
    expect(out.has("attachables/geyser_custom/armor/custom_ruby_leggings.json")).toBe(true);
  });

  it("detects legacy custom armor layer textures", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/custom/textures/models/armor/obsidian_layer_1.png": png(),
      "assets/custom/textures/models/armor/obsidian_layer_2.png": png(),
    });
    const result = await convertPack(zip, { packName: "Legacy Armor" });
    const out = readZip(result.mcpack);
    expect(out.has("attachables/geyser_custom/armor/custom_obsidian_helmet.json")).toBe(true);
    expect(out.has("attachables/geyser_custom/armor/custom_obsidian_leggings.json")).toBe(true);
    expect(out.has("textures/geyser_custom/armor/custom_obsidian_layer1.png")).toBe(true);
  });
});
