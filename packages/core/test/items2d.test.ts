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

describe("2D custom items", () => {
  it("bakes config dye colours into tinted-base-item icons", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/leather_boots.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "minecraft:item/leather_boots" },
        overrides: [{ predicate: { custom_model_data: 1 }, model: "custom:item/red_boots" }],
      }),
      "assets/custom/models/item/red_boots.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/red_boots" },
      }),
      // White sprite → tint result equals the colour itself.
      "assets/custom/textures/item/red_boots.png": png(16, 16, [255, 255, 255, 255]),
    });

    const result = await convertPack(zip, {
      packName: "Tint",
      colorHints: { red_boots: 0xff2000 },
    });
    const out = readZip(result.mcpack);
    const iconPath = "textures/geyser_custom/custom_item_red_boots_ff2000.png";
    expect(out.has(iconPath)).toBe(true);
    // Baked, so no "cannot be applied" warning for this variant.
    const warn = result.report.entries.find(
      (e) => e.status === "approximated" && e.detail?.includes("tints layer0 server-side"),
    );
    expect(warn).toBeUndefined();
  });

  it("maps legacy cast/charged/firework predicates to Geyser conditions", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/crossbow.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "minecraft:item/crossbow_standby" },
        overrides: [
          { predicate: { custom_model_data: 1 }, model: "custom:item/gun" },
          { predicate: { custom_model_data: 1, charged: 1 }, model: "custom:item/gun_loaded" },
          { predicate: { custom_model_data: 1, charged: 1, firework: 1 }, model: "custom:item/gun_rocket" },
        ],
      }),
      "assets/minecraft/models/item/fishing_rod.json": JSON.stringify({
        parent: "minecraft:item/handheld_rod",
        textures: { layer0: "minecraft:item/fishing_rod" },
        overrides: [
          { predicate: { custom_model_data: 2, cast: 1 }, model: "custom:item/hook_cast" },
        ],
      }),
      "assets/custom/models/item/gun.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/gun" },
      }),
      "assets/custom/models/item/gun_loaded.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/gun" },
      }),
      "assets/custom/models/item/gun_rocket.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/gun" },
      }),
      "assets/custom/models/item/hook_cast.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/gun" },
      }),
      "assets/custom/textures/item/gun.png": png(),
    });

    const result = await convertPack(zip, { packName: "Predicates" });
    const mappings = JSON.parse(result.geyserMappings!);
    const crossbow = mappings.items["minecraft:crossbow"];
    expect(crossbow).toHaveLength(3);
    expect(crossbow[1].predicate[0]).toMatchObject({
      type: "match",
      property: "charge_type",
      value: "arrow",
    });
    expect(crossbow[2].predicate[0]).toMatchObject({
      type: "match",
      property: "charge_type",
      value: "rocket",
    });
    const rod = mappings.items["minecraft:fishing_rod"];
    expect(rod[0].predicate[0]).toMatchObject({ type: "condition", property: "fishing_rod_cast" });
  });

  it("converts legacy custom_model_data overrides to v2 legacy mappings", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/stick.json": JSON.stringify({
        parent: "minecraft:item/handheld",
        textures: { layer0: "minecraft:item/stick" },
        overrides: [
          { predicate: { custom_model_data: 1 }, model: "custom:item/ruby_wand" },
          { predicate: { custom_model_data: 2 }, model: "custom:item/emerald_wand" },
        ],
      }),
      "assets/custom/models/item/ruby_wand.json": JSON.stringify({
        parent: "minecraft:item/handheld",
        textures: { layer0: "custom:item/ruby_wand" },
      }),
      "assets/custom/models/item/emerald_wand.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/emerald_wand" },
      }),
      "assets/custom/textures/item/ruby_wand.png": png(),
      "assets/custom/textures/item/emerald_wand.png": png(16, 16, [0, 255, 0, 255]),
    });

    const result = await convertPack(zip, { packName: "Items" });
    expect(result.geyserMappings).toBeDefined();
    const mappings = JSON.parse(result.geyserMappings!);
    expect(mappings.format_version).toBe(2);
    const stick = mappings.items["minecraft:stick"];
    expect(stick).toHaveLength(2);
    expect(stick[0]).toMatchObject({
      type: "legacy",
      custom_model_data: 1,
      bedrock_identifier: "geyser_custom:custom_item_ruby_wand",
    });
    expect(stick[0].bedrock_options.display_handheld).toBe(true);
    expect(stick[1].bedrock_options.display_handheld).toBe(false);

    const out = readZip(result.mcpack);
    expect(out.has("textures/geyser_custom/custom_item_ruby_wand.png")).toBe(true);
    const itemTexture = JSON.parse(out.readText("textures/item_texture.json")!);
    expect(itemTexture.texture_data["custom_item_ruby_wand"].textures).toBe(
      "textures/geyser_custom/custom_item_ruby_wand",
    );
  });

  it("converts modern item definitions (1.21.4+) with range_dispatch and condition", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/custom/items/magic_orb.json": JSON.stringify({
        model: {
          type: "minecraft:condition",
          property: "minecraft:damaged",
          on_true: { type: "minecraft:model", model: "custom:item/magic_orb_damaged" },
          on_false: { type: "minecraft:model", model: "custom:item/magic_orb" },
        },
      }),
      "assets/custom/models/item/magic_orb.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/magic_orb" },
      }),
      "assets/custom/models/item/magic_orb_damaged.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/magic_orb_damaged" },
      }),
      "assets/custom/textures/item/magic_orb.png": png(),
      "assets/custom/textures/item/magic_orb_damaged.png": png(),
    });

    const result = await convertPack(zip, { packName: "Modern" });
    const mappings = JSON.parse(result.geyserMappings!);
    // No fixed host → fallback base item.
    const defs = mappings.items["minecraft:paper"];
    expect(defs).toHaveLength(2);
    expect(defs[0]).toMatchObject({ type: "definition", model: "custom:magic_orb" });
    expect(defs[0].predicate[0]).toMatchObject({ type: "condition", property: "damaged" });
    expect(defs[1].predicate[0]).toMatchObject({ type: "condition", property: "damaged", expected: false });
  });

  it("drops Geyser-unsupported condition properties, keeping the default branch", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/custom/items/shield.json": JSON.stringify({
        model: {
          type: "minecraft:condition",
          property: "minecraft:using_item",
          on_true: { type: "minecraft:model", model: "custom:item/shield_blocking" },
          on_false: { type: "minecraft:model", model: "custom:item/shield" },
        },
      }),
      "assets/custom/models/item/shield.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/shield" },
      }),
      "assets/custom/models/item/shield_blocking.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/shield" },
      }),
      "assets/custom/textures/item/shield.png": png(),
    });
    const result = await convertPack(zip, { packName: "Shield" });
    const text = result.geyserMappings!;
    // Geyser rejects unknown condition properties — must never appear.
    expect(text).not.toContain("using_item");
    const defs = JSON.parse(text).items["minecraft:paper"];
    // Only the default (on_false) branch converts, without any predicate.
    expect(defs).toHaveLength(1);
    expect(defs[0].predicate).toBeUndefined();
    expect(defs[0].model).toBe("custom:shield");
  });

  it("composites multi-layer sprites into one icon", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/potion.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/base", layer1: "custom:item/overlay" },
        overrides: [{ predicate: { custom_model_data: 7 }, model: "minecraft:item/potion" }],
      }),
      "assets/custom/textures/item/base.png": png(16, 16, [255, 0, 0, 255]),
      "assets/custom/textures/item/overlay.png": png(16, 16, [0, 0, 255, 128]),
    });
    const result = await convertPack(zip, { packName: "Layers" });
    const out = readZip(result.mcpack);
    expect(out.has("textures/geyser_custom/minecraft_item_potion.png")).toBe(true);
    expect(result.report.summary.error).toBe(0);
  });

  it("infers host item from model parent chain for custom-namespace modern items", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/custom/items/ruby_sword.json": JSON.stringify({
        model: { type: "minecraft:model", model: "custom:item/ruby_sword" },
      }),
      "assets/custom/models/item/ruby_sword.json": JSON.stringify({
        parent: "minecraft:item/diamond_sword",
        textures: { layer0: "custom:item/ruby_sword" },
      }),
      "assets/custom/textures/item/ruby_sword.png": png(),
    });

    const result = await convertPack(zip, { packName: "Inferred" });
    const mappings = JSON.parse(result.geyserMappings!);
    // Host item inferred from parent (minecraft:item/diamond_sword), not fallback paper.
    const defs = mappings.items["minecraft:diamond_sword"];
    expect(defs).toBeDefined();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ type: "definition", model: "custom:ruby_sword" });
    // Must NOT appear under the fallback base item.
    expect(mappings.items["minecraft:paper"]).toBeUndefined();
    // No config-nudge since no fallback hits.
    const nudge = result.report.entries.find(
      (e) => e.status === "approximated" && e.detail?.includes("modern item-model assets"),
    );
    expect(nudge).toBeUndefined();
  });

  it("falls back to modernBaseItem when model parents to a generic vanilla parent", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/custom/items/mystery_item.json": JSON.stringify({
        model: { type: "minecraft:model", model: "custom:item/mystery_item" },
      }),
      "assets/custom/models/item/mystery_item.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/mystery_item" },
      }),
      "assets/custom/textures/item/mystery_item.png": png(),
    });

    const result = await convertPack(zip, { packName: "Fallback" });
    const mappings = JSON.parse(result.geyserMappings!);
    // Generic parent (item/generated) → no inference → fallback.
    expect(mappings.items["minecraft:diamond_sword"]).toBeUndefined();
    expect(mappings.items["minecraft:paper"]).toBeDefined();
  });

  it("infers host item for non-handheld vanilla items not in BUILTIN_MODELS", async () => {
    // minecraft:item/apple is not in BUILTIN_MODELS — the resolver synthesizes
    // a generated-parent fallback so the chain walks through it and inference
    // finds minecraft:apple as the host item.
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/custom/items/golden_apple_custom.json": JSON.stringify({
        model: { type: "minecraft:model", model: "custom:item/golden_apple_custom" },
      }),
      "assets/custom/models/item/golden_apple_custom.json": JSON.stringify({
        parent: "minecraft:item/apple",
        textures: { layer0: "custom:item/golden_apple_custom" },
      }),
      "assets/custom/textures/item/golden_apple_custom.png": png(),
    });

    const result = await convertPack(zip, { packName: "Apple" });
    const mappings = JSON.parse(result.geyserMappings!);
    const defs = mappings.items["minecraft:apple"];
    expect(defs).toBeDefined();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ type: "definition", model: "custom:golden_apple_custom" });
    expect(mappings.items["minecraft:paper"]).toBeUndefined();
  });
});
