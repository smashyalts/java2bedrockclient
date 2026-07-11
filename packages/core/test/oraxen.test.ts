import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { convertPack, parseOraxenConfigZip } from "../src/index.js";
import { encode } from "fast-png";

function fixtureZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(tree);
}

function png(): Uint8Array {
  const data = new Uint8Array(16 * 16 * 4).fill(99);
  return new Uint8Array(encode({ width: 16, height: 16, data, channels: 4 }));
}

const ORAXEN_YML = `
ruby_sword:
  displayname: "&cRuby Sword"
  material: DIAMOND_SWORD
  Pack:
    generate_model: true
    parent_model: item/handheld
abyss_boots:
  displayname: "Abyss Boots"
  material: LEATHER_BOOTS
  Components:
    item_model: oraxen:abyss_boots_model
not_an_item:
  some_setting: true
`;

describe("oraxen config hints", () => {
  it("parses item base materials from yml configs", () => {
    const zip = fixtureZip({ "items/weapons.yml": ORAXEN_YML });
    const hints = parseOraxenConfigZip(zip);
    expect(hints.baseItems["ruby_sword"]).toBe("minecraft:diamond_sword");
    expect(hints.baseItems["abyss_boots"]).toBe("minecraft:leather_boots");
    // Components.item_model alias registered too.
    expect(hints.baseItems["abyss_boots_model"]).toBe("minecraft:leather_boots");
    expect(hints.baseItems["not_an_item"]).toBeUndefined();
    expect(hints.items).toBe(2);
  });

  it("parses ItemsAdder configs (items section, resource.material, model_path)", () => {
    const IA_YML = `
info:
  namespace: myitems
items:
  ruby_sword:
    display_name: display-name-ruby_sword
    resource:
      material: DIAMOND_SWORD
      generate: true
      textures:
        - item/ruby_sword.png
  magic_dust:
    resource:
      generate: true
      model_path: item/magic_dust_model
`;
    const hints = parseOraxenConfigZip(fixtureZip({ "contents/myitems/configs/items.yml": IA_YML }));
    expect(hints.baseItems["ruby_sword"]).toBe("minecraft:diamond_sword");
    // generated item without material → ItemsAdder default PAPER
    expect(hints.baseItems["magic_dust"]).toBe("minecraft:paper");
    // model_path alias
    expect(hints.baseItems["magic_dust_model"]).toBe("minecraft:paper");
    expect(hints.items).toBe(2);
  });

  it("detects HMCCosmetics backpack items (nexo ref and material+cmd forms)", () => {
    const HMCC_YML = `
leaf_wings:
  slot: BACKPACK
  item:
    material: "nexo:fantastic_wings"
old_wings:
  type: BACKPACK
  item:
    material: PAPER
    model-data: 55
`;
    const NEXO_YML = `
paper_wings:
  material: PAPER
  Pack:
    custom_model_data: 55
`;
    const hints = parseOraxenConfigZip(
      fixtureZip({ "cosmetics/back.yml": HMCC_YML, "items/wings.yml": NEXO_YML }),
    );
    expect(hints.backpacks).toContain("fantastic_wings");
    expect(hints.backpacks).toContain("paper_wings"); // resolved via material+cmd
  });

  it("detects furniture items (Oraxen Mechanics + ItemsAdder behaviours)", () => {
    const NEXO_FURNITURE_YML = `
plushie_bear:
  material: PAPER
  Components:
    item_model: nexo:plushie_bear
  Mechanics:
    furniture:
      type: DISPLAY_ENTITY
      hitbox: { width: 1, height: 1 }
`;
    const IA_FURNITURE_YML = `
items:
  garden_chair:
    resource:
      material: PAPER
      generate: true
    behaviours:
      furniture:
        entity: item_display
`;
    const hints = parseOraxenConfigZip(
      fixtureZip({ "items/furniture.yml": NEXO_FURNITURE_YML, "contents/x/configs/f.yml": IA_FURNITURE_YML }),
    );
    expect(hints.furniture).toContain("plushie_bear");
    expect(hints.furniture).toContain("plushie_bear"); // key itself
    expect(hints.furniture).toContain("garden_chair");
    expect(hints.furniture).not.toContain("ruby_sword");
  });

  it("emits GeyserDisplayEntity mappings YAML for furniture items", async () => {
    const packZip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/nexo/items/plushie_bear.json": JSON.stringify({
        model: { type: "minecraft:model", model: "nexo:item/plushie_bear" },
      }),
      "assets/nexo/models/item/plushie_bear.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "nexo:item/plushie_bear" },
      }),
      "assets/nexo/textures/item/plushie_bear.png": png(),
    });
    const result = await convertPack(packZip, {
      packName: "Furniture",
      baseItemHints: { plushie_bear: "minecraft:paper" },
      furnitureItems: ["plushie_bear"],
    });
    expect(result.displayEntityMappings).toBeDefined();
    expect(result.displayEntityMappings).toContain("mappings:");
    expect(result.displayEntityMappings).toContain('type: "minecraft:paper"');
    expect(result.displayEntityMappings).toContain('item-identifier: "plushie_bear"');
  });

  it("maps modern item definitions under hinted base items", async () => {
    const packZip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/oraxen/items/ruby_sword.json": JSON.stringify({
        model: { type: "minecraft:model", model: "oraxen:item/ruby_sword" },
      }),
      "assets/oraxen/models/item/ruby_sword.json": JSON.stringify({
        parent: "minecraft:item/handheld",
        textures: { layer0: "oraxen:item/ruby_sword" },
      }),
      "assets/oraxen/textures/item/ruby_sword.png": png(),
    });
    const hints = parseOraxenConfigZip(fixtureZip({ "items/weapons.yml": ORAXEN_YML }));
    const result = await convertPack(packZip, { packName: "Hints", baseItemHints: hints.baseItems });
    const mappings = JSON.parse(result.geyserMappings!);
    expect(mappings.items["minecraft:diamond_sword"]).toHaveLength(1);
    expect(mappings.items["minecraft:paper"]).toBeUndefined();
  });
});
