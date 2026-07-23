import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { convertPack, parseOraxenConfigZip } from "../src/index.js";
import { readZipDetailed } from "../src/io/zip.js";
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

/** Fully-opaque PNG (all pixels alpha 255) — colour channels set, alpha solid. */
function opaquePng(): Uint8Array {
  const data = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 120;
    data[i + 1] = 80;
    data[i + 2] = 40;
    data[i + 3] = 255;
  }
  return new Uint8Array(encode({ width: 16, height: 16, data, channels: 4 }));
}

/** PNG opaque only in the top-left 8×8 (UV 0..8), transparent padding elsewhere. */
function paddedPng(): Uint8Array {
  const data = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      data[i] = 100;
      data[i + 1] = 60;
      data[i + 2] = 30;
      data[i + 3] = x < 8 && y < 8 ? 255 : 0;
    }
  }
  return new Uint8Array(encode({ width: 16, height: 16, data, channels: 4 }));
}

/** All attachable JSON files in the pack, keyed by path. */
function attachables(mcpack: Uint8Array): { path: string; json: any }[] {
  const { vfs } = readZipDetailed(mcpack);
  return vfs
    .list()
    .filter((p) => p.startsWith("attachables/") && p.endsWith(".json"))
    .map((p) => ({ path: p, json: JSON.parse(new TextDecoder().decode(vfs.read(p)!)) }));
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

  it("extracts fixed dye colours (R,G,B and hex forms)", () => {
    const YML = `
red_cap:
  material: LEATHER_HELMET
  color: "255, 0, 0"
blue_cap:
  material: LEATHER_HELMET
  color: "#0000FF"
plain_cap:
  material: LEATHER_HELMET
`;
    const hints = parseOraxenConfigZip(fixtureZip({ "items/caps.yml": YML }));
    expect(hints.colors["red_cap"]).toBe(0xff0000);
    expect(hints.colors["blue_cap"]).toBe(0x0000ff);
    expect(hints.colors["plain_cap"]).toBeUndefined();
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

  it("seats furniture by its bottom, not its bounding-box centre", async () => {
    // A model whose bottom sits 8 units above the block origin. Bottom-anchored
    // seating gives -0.5 - 8/16 = -1.0. A centre-based offset would instead use
    // the mid-point (16) and sink the piece by half its excess height.
    const packZip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/nexo/items/tall_chair.json": JSON.stringify({
        model: { type: "minecraft:model", model: "nexo:item/tall_chair" },
      }),
      "assets/nexo/models/item/tall_chair.json": JSON.stringify({
        textures: { "1": "nexo:item/tall_chair" },
        elements: [
          { from: [4, 8, 4], to: [12, 24, 12], faces: { north: { texture: "#1" }, south: { texture: "#1" } } },
        ],
      }),
      "assets/nexo/textures/item/tall_chair.png": png(),
    });
    const result = await convertPack(packZip, {
      packName: "Chair",
      baseItemHints: { tall_chair: "minecraft:leather_horse_armor" },
      furnitureItems: ["tall_chair"],
    });
    const yml = result.displayEntityMappings!;
    expect(yml).toContain("y-offset: -1.000");
    // Not the flat default — the raised bottom must move the offset.
    expect(yml).not.toContain("y-offset: -0.500");
    // Furniture on leather_horse_armor is hidden by the extension default →
    // a corrected config.yml is emitted with it removed from hide-custom-types.
    const cfg = result.displayEntityConfig!;
    expect(cfg).toBeDefined();
    expect(cfg).toContain("hide-custom-types: []");
    // hide-types stays intact so vanilla item-displays are still hidden.
    expect(cfg).toContain('- "minecraft:leather_horse_armor"');
  });

  it("emits display.fixed rotation and seats furniture by its stood-up height", async () => {
    // A chair modelled lying down: tall span is along Z (0..24), thin in Y.
    // Java's display.fixed rotation [-90,0,0] stands it upright; without it the
    // Bedrock attachable renders flat. We emit that rotation and derive the
    // y-offset from the rotated bounds (Z→Y), so it's seated by its real height.
    const packZip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/nexo/items/lying_chair.json": JSON.stringify({
        model: { type: "minecraft:model", model: "nexo:item/lying_chair" },
      }),
      "assets/nexo/models/item/lying_chair.json": JSON.stringify({
        textures: { "1": "nexo:item/lying_chair" },
        elements: [
          { from: [4, 6, 4], to: [12, 10, 24], faces: { north: { texture: "#1" }, south: { texture: "#1" } } },
        ],
        display: { fixed: { rotation: [-90, 0, 0] } },
      }),
      "assets/nexo/textures/item/lying_chair.png": png(),
    });
    const result = await convertPack(packZip, {
      packName: "Chair",
      baseItemHints: { lying_chair: "minecraft:paper" },
      furnitureItems: ["lying_chair"],
    });
    const yml = result.displayEntityMappings!;
    // Fixed rotation carried into the extension mapping.
    expect(yml).toContain("rotation: [-90.0, 0.0, 0.0]");
    // Rotated bounds: Z 0..24 becomes the vertical span, centre ~ -4 units off
    // the pivot → offset well below the flat-model default, not -0.500.
    expect(yml).not.toContain("y-offset: -0.500");
    expect(yml).toMatch(/y-offset: -0\.(6|7|8)/);
  });

  it("omits the furniture config.yml when no furniture uses a hidden base item", async () => {
    const packZip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/nexo/items/paper_lamp.json": JSON.stringify({
        model: { type: "minecraft:model", model: "nexo:item/paper_lamp" },
      }),
      "assets/nexo/models/item/paper_lamp.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "nexo:item/paper_lamp" },
      }),
      "assets/nexo/textures/item/paper_lamp.png": png(),
    });
    const result = await convertPack(packZip, {
      packName: "Paper",
      baseItemHints: { paper_lamp: "minecraft:paper" },
      furnitureItems: ["paper_lamp"],
    });
    expect(result.displayEntityMappings).toBeDefined();
    // paper isn't hidden by default → no config.yml needed.
    expect(result.displayEntityConfig).toBeUndefined();
  });

  it("renders opaque 3D furniture double-sided (entity_nocull) so concave pieces keep their faces", async () => {
    const packZip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/nexo/items/sofa.json": JSON.stringify({
        model: { type: "minecraft:model", model: "nexo:item/sofa" },
      }),
      "assets/nexo/models/item/sofa.json": JSON.stringify({
        textures: { "1": "nexo:item/sofa" },
        elements: [
          { from: [0, 0, 0], to: [16, 8, 16], faces: { north: { texture: "#1" }, up: { texture: "#1" } } },
        ],
      }),
      "assets/nexo/textures/item/sofa.png": opaquePng(),
    });
    const result = await convertPack(packZip, {
      packName: "Sofa",
      baseItemHints: { sofa: "minecraft:paper" },
      furnitureItems: ["sofa"],
    });
    const files = attachables(result.mcpack);
    expect(files.length).toBeGreaterThan(0);
    // Opaque furniture → vanilla double-sided material (no back-face culling).
    for (const { json } of files) {
      expect(json["minecraft:attachable"].description.materials.default).toBe("entity_nocull");
    }
  });

  it("double-sides furniture that samples only opaque texels of a padded texture", async () => {
    // Texture is opaque in UV 0..8 and transparent padding elsewhere. The face
    // samples only the opaque region → entity_nocull. A whole-texture opacity
    // check would wrongly see the padding and keep it one-sided.
    const packZip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/nexo/items/padded_sofa.json": JSON.stringify({
        model: { type: "minecraft:model", model: "nexo:item/padded_sofa" },
      }),
      "assets/nexo/models/item/padded_sofa.json": JSON.stringify({
        textures: { "1": "nexo:item/padded_sofa" },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 8, 16],
            faces: {
              north: { texture: "#1", uv: [0, 0, 8, 8] },
              up: { texture: "#1", uv: [0, 0, 8, 8] },
            },
          },
        ],
      }),
      "assets/nexo/textures/item/padded_sofa.png": paddedPng(),
    });
    const result = await convertPack(packZip, {
      packName: "Padded",
      baseItemHints: { padded_sofa: "minecraft:paper" },
      furnitureItems: ["padded_sofa"],
    });
    const files = attachables(result.mcpack);
    expect(files.length).toBeGreaterThan(0);
    for (const { json } of files) {
      expect(json["minecraft:attachable"].description.materials.default).toBe("entity_nocull");
    }
  });

  it("keeps transparent 3D furniture one-sided (entity_nocull would show cutout pixels as solid)", async () => {
    const packZip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/nexo/items/lamp.json": JSON.stringify({
        model: { type: "minecraft:model", model: "nexo:item/lamp" },
      }),
      "assets/nexo/models/item/lamp.json": JSON.stringify({
        textures: { "1": "nexo:item/lamp" },
        elements: [
          { from: [0, 0, 0], to: [16, 8, 16], faces: { north: { texture: "#1" }, up: { texture: "#1" } } },
        ],
      }),
      // png() fills alpha 99 → has transparency.
      "assets/nexo/textures/item/lamp.png": png(),
    });
    const result = await convertPack(packZip, {
      packName: "Lamp",
      baseItemHints: { lamp: "minecraft:paper" },
      furnitureItems: ["lamp"],
    });
    const files = attachables(result.mcpack);
    expect(files.length).toBeGreaterThan(0);
    for (const { json } of files) {
      expect(json["minecraft:attachable"].description.materials.default).not.toBe("entity_nocull");
    }
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

  it("parses custom-plugin (oxywire) configs: material, nested item-model, name, decimal color", () => {
    const YML = `
FarmerHat:
  material: SLIME_BALL
  name: "<c:#dd9b00>Farmer Hat"
  item-model: "oxywire:cosmetics/hats/farmer_hat"
  color: "10568504"
BegrimedItem:
  material: RABBIT_FOOT
  name: "<dark_gray><b>Begrimed Item"
  item-model: "oxywire:item/begrimed_item"
  stackable: false
`;
    const hints = parseOraxenConfigZip(fixtureZip({ "items/oxy.yml": YML }));
    // Host item registered under full item-model path AND its last segment.
    expect(hints.baseItems["cosmetics/hats/farmer_hat"]).toBe("minecraft:slime_ball");
    expect(hints.baseItems["farmer_hat"]).toBe("minecraft:slime_ball");
    expect(hints.baseItems["item/begrimed_item"]).toBe("minecraft:rabbit_foot");
    // `name` display key + MiniMessage tags stripped.
    expect(hints.displayNames["cosmetics/hats/farmer_hat"]).toBe("Farmer Hat");
    expect(hints.displayNames["item/begrimed_item"]).toBe("Begrimed Item");
    // Packed decimal colour.
    expect(hints.colors["farmer_hat"]).toBe(10568504 & 0xffffff);
  });

  it("emits equippable head for a 3D model with a head display transform (hat cosmetic)", async () => {
    const packZip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/oxywire/items/hat.json": JSON.stringify({
        model: { type: "minecraft:model", model: "oxywire:item/hat" },
      }),
      "assets/oxywire/models/item/hat.json": JSON.stringify({
        textures: { "0": "oxywire:item/hat" },
        elements: [{ from: [0, 0, 0], to: [16, 4, 16], faces: { up: { texture: "#0" } } }],
        display: { gui: {}, head: {} },
      }),
      "assets/oxywire/textures/item/hat.png": png(),
    });
    const result = await convertPack(packZip, {
      packName: "Hat",
      baseItemHints: { hat: "minecraft:slime_ball" },
    });
    const mappings = JSON.parse(result.geyserMappings!);
    const def = mappings.items["minecraft:slime_ball"].find((e: any) => /hat/.test(e.model));
    expect(def.components["minecraft:equippable"].slot).toBe("head");
  });

  it("does NOT mark a held 3D item (hand display transforms) as head-equippable", async () => {
    const packZip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/oxywire/items/blade.json": JSON.stringify({
        model: { type: "minecraft:model", model: "oxywire:item/blade" },
      }),
      "assets/oxywire/models/item/blade.json": JSON.stringify({
        textures: { "0": "oxywire:item/blade" },
        elements: [{ from: [0, 0, 0], to: [16, 4, 16], faces: { up: { texture: "#0" } } }],
        display: { gui: {}, head: {}, thirdperson_righthand: {}, firstperson_righthand: {} },
      }),
      "assets/oxywire/textures/item/blade.png": png(),
    });
    const result = await convertPack(packZip, {
      packName: "Blade",
      baseItemHints: { blade: "minecraft:slime_ball" },
    });
    const mappings = JSON.parse(result.geyserMappings!);
    const def = mappings.items["minecraft:slime_ball"].find((e: any) => /blade/.test(e.model));
    expect(def.components?.["minecraft:equippable"]).toBeUndefined();
  });
});
