import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { convertPack, readZip } from "../src/index.js";

/** Solid-colour 16×16 PNG. */
function solid16(r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) data.set([r, g, b, 255], i * 4);
  return new Uint8Array(encode({ width: 16, height: 16, data, channels: 4 }));
}

function fixtureZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(tree);
}

const BOW_MODEL = {
  parent: "minecraft:item/generated",
  textures: { layer0: "minecraft:item/bow" },
  overrides: [
    { predicate: { pulling: 1 }, model: "minecraft:item/bow_pulling_0" },
    { predicate: { pulling: 1, pull: 0.65 }, model: "minecraft:item/bow_pulling_1" },
    { predicate: { pulling: 1, pull: 0.9 }, model: "minecraft:item/bow_pulling_2" },
  ],
};

const PULL_0 = {
  parent: "minecraft:item/generated",
  textures: { layer0: "minecraft:item/bow_pulling_0" },
};

const PULL_1 = {
  parent: "minecraft:item/generated",
  textures: { layer0: "minecraft:item/bow_pulling_1" },
};

const PULL_2 = {
  parent: "minecraft:item/generated",
  textures: { layer0: "minecraft:item/bow_pulling_2" },
};

describe("bow-pull render controller", () => {
  it("emits a charge-progress render controller and attachable for vanilla bow overrides", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/bow.json": JSON.stringify(BOW_MODEL),
      "assets/minecraft/models/item/bow_pulling_0.json": JSON.stringify(PULL_0),
      "assets/minecraft/models/item/bow_pulling_1.json": JSON.stringify(PULL_1),
      "assets/minecraft/models/item/bow_pulling_2.json": JSON.stringify(PULL_2),
      "assets/minecraft/textures/item/bow.png": solid16(100, 60, 30),
      "assets/minecraft/textures/item/bow_pulling_0.png": solid16(110, 65, 35),
      "assets/minecraft/textures/item/bow_pulling_1.png": solid16(120, 70, 40),
      "assets/minecraft/textures/item/bow_pulling_2.png": solid16(130, 75, 45),
    });

    const result = await convertPack(zip, { packName: "BowTest" });
    const out = readZip(result.mcpack);

    // Render controller exists and references charge-based Molang, not time-based.
    const rc = JSON.parse(
      out.readText("render_controllers/geyser_custom/bow_minecraft_bow.render_controllers.json")!,
    );
    const controller = rc.render_controllers["controller.render.gc_bow_minecraft_bow"];
    expect(controller).toBeDefined();
    expect(controller.arrays.textures["Array.frames"]).toEqual([
      "Texture.default",
      "Texture.pull1",
      "Texture.pull2",
      "Texture.pull3",
    ]);
    // Charge-based index: uses v.charge_amount, NOT q.life_time.
    const texExpr = controller.textures[0] as string;
    expect(texExpr).toContain("v.charge_amount");
    expect(texExpr).not.toContain("q.life_time");
    // Threshold ladder: highest pull stage (0.9) selects the last frame (3).
    expect(texExpr).toContain("v.charge_amount >= 0.9000 ? 3");
    expect(texExpr).toContain("v.charge_amount <= 0.0 ? 0");
    // Highest threshold must be tested BEFORE lower ones, else it's unreachable.
    expect(texExpr.indexOf("0.9000")).toBeLessThan(texExpr.indexOf("0.6500"));

    // Attachable references the bow-pull render controller.
    const attachable = JSON.parse(
      out.readText("attachables/geyser_custom/bow_minecraft_bow.json")!,
    );
    const desc = attachable["minecraft:attachable"].description;
    expect(desc.render_controllers).toEqual(["controller.render.gc_bow_minecraft_bow"]);
    // Pre_animation includes charge_amount computation.
    expect(desc.scripts.pre_animation).toEqual(
      expect.arrayContaining([expect.stringContaining("v.charge_amount")]),
    );
    // Extra textures for pull stages.
    expect(desc.textures.pull1).toBeDefined();
    expect(desc.textures.pull2).toBeDefined();
    expect(desc.textures.pull3).toBeDefined();

    // Stage textures are written.
    expect(out.has("textures/geyser_custom/bow_minecraft_bow_default.png")).toBe(true);
    expect(out.has("textures/geyser_custom/bow_minecraft_bow_pull1.png")).toBe(true);
    expect(out.has("textures/geyser_custom/bow_minecraft_bow_pull2.png")).toBe(true);
    expect(out.has("textures/geyser_custom/bow_minecraft_bow_pull3.png")).toBe(true);

    // Geyser mapping is registered on minecraft:bow.
    const mappings = JSON.parse(result.geyserMappings!);
    expect(mappings.items["minecraft:bow"]).toBeDefined();
    const bowDef = mappings.items["minecraft:bow"][0];
    expect(bowDef.type).toBe("definition");
    expect(bowDef.model).toBe("minecraft:item/bow");
    expect(bowDef.bedrock_identifier).toBe("geyser_custom:bow_minecraft_bow");
    expect(bowDef.bedrock_options.allow_offhand).toBe(true);

    // Report has a converted entry on the bow-pull stage.
    const entry = result.report.entries.find(
      (e) => e.stage === "bow-pull" && e.status === "converted",
    );
    expect(entry).toBeDefined();
    expect(entry!.outputs!.some((o) => o.includes("pull stages"))).toBe(true);
  });

  it("works with a 2-stage bow (only pulling:1, no continuous pull)", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/bow.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "minecraft:item/bow" },
        overrides: [
          { predicate: { pulling: 1 }, model: "minecraft:item/bow_pulling_0" },
        ],
      }),
      "assets/minecraft/models/item/bow_pulling_0.json": JSON.stringify(PULL_0),
      "assets/minecraft/textures/item/bow.png": solid16(100, 60, 30),
      "assets/minecraft/textures/item/bow_pulling_0.png": solid16(110, 65, 35),
    });

    const result = await convertPack(zip, { packName: "BowSimple" });
    const out = readZip(result.mcpack);

    const rc = JSON.parse(
      out.readText("render_controllers/geyser_custom/bow_minecraft_bow.render_controllers.json")!,
    );
    const controller = rc.render_controllers["controller.render.gc_bow_minecraft_bow"];
    // 2 frames: standby + 1 pull stage.
    expect(controller.arrays.textures["Array.frames"]).toHaveLength(2);
    // Single pull stage (threshold 0) selects frame 1 while drawing.
    expect(controller.textures[0]).toContain("? 1 :");
  });

  it("converts a modern custom-model bow (using_item → range_dispatch use_duration)", async () => {
    // Oraxen/Nexo-style: item definition under a custom namespace, host item
    // resolved from a config base-item hint.
    const bowDef = {
      model: {
        type: "minecraft:condition",
        property: "minecraft:using_item",
        on_false: { type: "minecraft:model", model: "violetset/bow" },
        on_true: {
          type: "minecraft:range_dispatch",
          property: "minecraft:use_duration",
          scale: 0.05,
          entries: [
            { threshold: 0.65, model: { type: "minecraft:model", model: "violetset/bow_1" } },
            { threshold: 0.9, model: { type: "minecraft:model", model: "violetset/bow_2" } },
          ],
          fallback: { type: "minecraft:model", model: "violetset/bow_0" },
        },
      },
    };
    // Oraxen dumps custom models/textures under the minecraft namespace, so an
    // unqualified model ref like "violetset/bow" resolves to minecraft:.
    const spriteModel = (tex: string) => JSON.stringify({
      parent: "minecraft:item/generated",
      textures: { layer0: tex },
    });
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/oraxen/items/abyss_bow.json": JSON.stringify(bowDef),
      "assets/minecraft/models/violetset/bow.json": spriteModel("minecraft:violetset/bow"),
      "assets/minecraft/models/violetset/bow_0.json": spriteModel("minecraft:violetset/bow_0"),
      "assets/minecraft/models/violetset/bow_1.json": spriteModel("minecraft:violetset/bow_1"),
      "assets/minecraft/models/violetset/bow_2.json": spriteModel("minecraft:violetset/bow_2"),
      "assets/minecraft/textures/violetset/bow.png": solid16(100, 60, 30),
      "assets/minecraft/textures/violetset/bow_0.png": solid16(110, 65, 35),
      "assets/minecraft/textures/violetset/bow_1.png": solid16(120, 70, 40),
      "assets/minecraft/textures/violetset/bow_2.png": solid16(130, 75, 45),
    });

    const result = await convertPack(zip, {
      packName: "ModernBow",
      baseItemHints: { abyss_bow: "minecraft:bow" },
      displayNameHints: { abyss_bow: "Abyss Bow" },
    });

    // Mapped on minecraft:bow (from the hint), type definition, model = item id.
    const mappings = JSON.parse(result.geyserMappings!);
    expect(mappings.items["minecraft:bow"]).toBeDefined();
    const def = mappings.items["minecraft:bow"][0];
    expect(def.type).toBe("definition");
    expect(def.model).toBe("oraxen:abyss_bow");
    expect(def.display_name).toBe("Abyss Bow");

    // Not ALSO emitted as a plain skipped/default modern variant.
    const usingItemSkip = result.report.entries.find(
      (e) => e.stage === "items" && (e.detail ?? "").includes("using_item"),
    );
    expect(usingItemSkip).toBeUndefined();

    // Render controller with 3 frames (standby + 2 pull stages, fallback merges
    // into stage 0 → 3 stage frames total: bow_0, bow_1, bow_2).
    const bowEntry = result.report.entries.find(
      (e) => e.stage === "bow-pull" && e.status === "converted",
    );
    expect(bowEntry).toBeDefined();
  });

  it("skips bows that mix sprite and 3D pull stages", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/bow.json": JSON.stringify(BOW_MODEL),
      "assets/minecraft/models/item/bow_pulling_0.json": JSON.stringify(PULL_0),
      "assets/minecraft/models/item/bow_pulling_1.json": JSON.stringify(PULL_1),
      "assets/minecraft/models/item/bow_pulling_2.json": JSON.stringify({
        // 3D model with elements — mixed with the sprite stages above.
        textures: { body: "minecraft:item/bow_pulling_2" },
        elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: "#body" } } }],
      }),
      "assets/minecraft/textures/item/bow.png": solid16(100, 60, 30),
      "assets/minecraft/textures/item/bow_pulling_0.png": solid16(110, 65, 35),
      "assets/minecraft/textures/item/bow_pulling_1.png": solid16(120, 70, 40),
      "assets/minecraft/textures/item/bow_pulling_2.png": solid16(130, 75, 45),
    });

    const result = await convertPack(zip, { packName: "BowMixed" });
    const entry = result.report.entries.find(
      (e) => e.stage === "bow-pull" && e.status === "skipped",
    );
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain("mix sprite and 3D");
  });

  it("converts a 3D custom-model bow with a geometry array per pull stage", async () => {
    const bowDef = {
      model: {
        type: "minecraft:condition",
        property: "minecraft:using_item",
        on_false: { type: "minecraft:model", model: "gemset/bow" },
        on_true: {
          type: "minecraft:range_dispatch",
          property: "minecraft:use_duration",
          scale: 0.05,
          entries: [{ threshold: 0.9, model: { type: "minecraft:model", model: "gemset/bow_1" } }],
          fallback: { type: "minecraft:model", model: "gemset/bow_0" },
        },
      },
    };
    // 3D bow model: a single textured cube.
    const cube = (tex: string) => JSON.stringify({
      textures: { body: tex },
      elements: [{ from: [4, 0, 4], to: [12, 16, 12], faces: { north: { texture: "#body" }, south: { texture: "#body" } } }],
      display: { gui: {} },
    });
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 46 } }),
      "assets/oraxen/items/gem_bow.json": JSON.stringify(bowDef),
      "assets/minecraft/models/gemset/bow.json": cube("minecraft:gemset/bow"),
      "assets/minecraft/models/gemset/bow_0.json": cube("minecraft:gemset/bow_0"),
      "assets/minecraft/models/gemset/bow_1.json": cube("minecraft:gemset/bow_1"),
      "assets/minecraft/textures/gemset/bow.png": solid16(100, 60, 30),
      "assets/minecraft/textures/gemset/bow_0.png": solid16(110, 65, 35),
      "assets/minecraft/textures/gemset/bow_1.png": solid16(120, 70, 40),
    });

    const result = await convertPack(zip, {
      packName: "Gem3DBow",
      baseItemHints: { gem_bow: "minecraft:bow" },
    });
    const out = readZip(result.mcpack);

    const entry = result.report.entries.find(
      (e) => e.stage === "bow-pull" && e.status === "converted",
    );
    expect(entry).toBeDefined();
    expect(entry!.outputs!.some((o) => o.includes("3D bow"))).toBe(true);

    // Render controller selects geometry from an array (per-stage meshes).
    const rc = JSON.parse(
      out.readText("render_controllers/geyser_custom/bow_oraxen_gem_bow.render_controllers.json")!,
    );
    const controller = rc.render_controllers["controller.render.gc_bow_oraxen_gem_bow"];
    expect(controller.arrays.geometries["Array.geos"]).toHaveLength(3);
    expect(controller.geometry).toContain("Array.geos[");

    // A distinct geometry file per stage is written.
    expect(out.has("models/entity/geyser_custom/bow_oraxen_gem_bow_default.geo.json")).toBe(true);
    expect(out.has("models/entity/geyser_custom/bow_oraxen_gem_bow_pull1.geo.json")).toBe(true);
    expect(out.has("models/entity/geyser_custom/bow_oraxen_gem_bow_pull2.geo.json")).toBe(true);

    // Attachable declares all stage geometries.
    const attachable = JSON.parse(out.readText("attachables/geyser_custom/bow_oraxen_gem_bow.json")!);
    const geo = attachable["minecraft:attachable"].description.geometry;
    expect(Object.keys(geo)).toEqual(expect.arrayContaining(["default", "pull1", "pull2"]));
  });

  it("does not emit bow-pull entries for items without pulling overrides", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/stick.json": JSON.stringify({
        parent: "minecraft:item/handheld",
        textures: { layer0: "minecraft:item/stick" },
        overrides: [{ predicate: { custom_model_data: 1 }, model: "custom:item/fancy_stick" }],
      }),
      "assets/custom/models/item/fancy_stick.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "custom:item/fancy_stick" },
      }),
      "assets/custom/textures/item/fancy_stick.png": solid16(200, 200, 200),
    });

    const result = await convertPack(zip, { packName: "NoBow" });
    // No bow-pull stage entries at all.
    const bowEntries = result.report.entries.filter((e) => e.stage === "bow-pull");
    expect(bowEntries).toHaveLength(0);
  });
});
