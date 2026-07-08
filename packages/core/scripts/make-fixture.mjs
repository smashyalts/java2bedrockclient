// Builds a small but feature-complete Java resource pack zip for manual testing.
// Usage: node scripts/make-fixture.mjs <output.zip>
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { writeFileSync } from "node:fs";

const enc = new TextEncoder();

function png(width = 16, height = 16, rgba = [255, 40, 40, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return new Uint8Array(encode({ width, height, data, channels: 4 }));
}

const files = {
  "pack.mcmeta": enc.encode(JSON.stringify({ pack: { pack_format: 34, description: "GeyserConverter fixture" } })),
  "pack.png": png(64, 64, [40, 200, 120, 255]),
  // vanilla retextures
  "assets/minecraft/textures/block/oak_log.png": png(),
  "assets/minecraft/textures/item/golden_apple.png": png(16, 16, [250, 200, 40, 255]),
  // legacy 2D custom item
  "assets/minecraft/models/item/stick.json": enc.encode(JSON.stringify({
    parent: "minecraft:item/handheld",
    textures: { layer0: "minecraft:item/stick" },
    overrides: [
      { predicate: { custom_model_data: 1 }, model: "fixture:item/ruby_wand" },
      { predicate: { custom_model_data: 2 }, model: "fixture:item/big_sword" },
    ],
  })),
  "assets/fixture/models/item/ruby_wand.json": enc.encode(JSON.stringify({
    parent: "minecraft:item/handheld",
    textures: { layer0: "fixture:item/ruby_wand" },
  })),
  "assets/fixture/textures/item/ruby_wand.png": png(16, 16, [230, 40, 90, 255]),
  // 3D custom item
  "assets/fixture/models/item/big_sword.json": enc.encode(JSON.stringify({
    textures: { blade: "fixture:item/blade", particle: "fixture:item/blade" },
    elements: [{
      from: [7, 0, 7], to: [9, 16, 9],
      faces: {
        north: { uv: [0, 0, 2, 16], texture: "#blade" },
        south: { uv: [0, 0, 2, 16], texture: "#blade" },
        east: { uv: [0, 0, 2, 16], texture: "#blade" },
        west: { uv: [0, 0, 2, 16], texture: "#blade" },
        up: { uv: [0, 0, 2, 2], texture: "#blade" },
        down: { uv: [0, 0, 2, 2], texture: "#blade" },
      },
    }],
    display: { thirdperson_righthand: { rotation: [0, 45, 0], translation: [0, 2, 0], scale: [1.2, 1.2, 1.2] } },
  })),
  "assets/fixture/textures/item/blade.png": png(16, 16, [120, 220, 255, 255]),
  // modern item definition
  "assets/fixture/items/magic_orb.json": enc.encode(JSON.stringify({
    model: { type: "minecraft:model", model: "fixture:item/magic_orb" },
  })),
  "assets/fixture/models/item/magic_orb.json": enc.encode(JSON.stringify({
    parent: "minecraft:item/generated",
    textures: { layer0: "fixture:item/magic_orb" },
  })),
  "assets/fixture/textures/item/magic_orb.png": png(16, 16, [180, 90, 255, 255]),
  // armor (modern equipment + matching helmet item)
  "assets/fixture/equipment/ruby.json": enc.encode(JSON.stringify({
    layers: { humanoid: [{ texture: "fixture:ruby" }], humanoid_leggings: [{ texture: "fixture:ruby" }] },
  })),
  "assets/fixture/textures/entity/equipment/humanoid/ruby.png": png(64, 32, [220, 40, 90, 255]),
  "assets/fixture/textures/entity/equipment/humanoid_leggings/ruby.png": png(64, 32, [200, 30, 80, 255]),
  "assets/fixture/items/ruby_helmet.json": enc.encode(JSON.stringify({
    model: { type: "minecraft:model", model: "fixture:item/ruby_helmet" },
  })),
  "assets/fixture/models/item/ruby_helmet.json": enc.encode(JSON.stringify({
    parent: "minecraft:item/generated",
    textures: { layer0: "fixture:item/ruby_helmet" },
  })),
  "assets/fixture/textures/item/ruby_helmet.png": png(16, 16, [220, 40, 90, 255]),
  // flipbook
  "assets/minecraft/textures/block/magma.png": png(16, 64, [255, 90, 20, 255]),
  "assets/minecraft/textures/block/magma.png.mcmeta": enc.encode(JSON.stringify({ animation: { frametime: 8 } })),
  // sounds + lang
  "assets/fixture/sounds.json": enc.encode(JSON.stringify({ "magic.zap": { category: "player", sounds: ["magic/zap"] } })),
  "assets/fixture/sounds/magic/zap.ogg": new Uint8Array([79, 103, 103, 83]),
  "assets/fixture/lang/en_us.json": enc.encode(JSON.stringify({ "item.fixture.ruby_wand": "Ruby Wand" })),
};

const out = process.argv[2] ?? "fixture-pack.zip";
writeFileSync(out, zipSync(files));
console.log("wrote", out);
