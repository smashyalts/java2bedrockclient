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
    expect(texExpr).toContain("math.min(3");

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
    expect(entry!.outputs!.some((o) => o.includes("render controller"))).toBe(true);
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
    expect(controller.textures[0]).toContain("math.min(1");
  });

  it("skips non-sprite bow models and reports them", async () => {
    // A bow model with 3D elements (geometry kind) — should be skipped.
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/bow.json": JSON.stringify(BOW_MODEL),
      "assets/minecraft/models/item/bow_pulling_0.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "minecraft:item/bow_pulling_0" },
      }),
      "assets/minecraft/models/item/bow_pulling_1.json": JSON.stringify(PULL_1),
      "assets/minecraft/models/item/bow_pulling_2.json": JSON.stringify({
        // 3D model with elements — not a sprite.
        textures: { body: "minecraft:item/bow_pulling_2" },
        elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: "#body" } } }],
      }),
      "assets/minecraft/textures/item/bow.png": solid16(100, 60, 30),
      "assets/minecraft/textures/item/bow_pulling_0.png": solid16(110, 65, 35),
      "assets/minecraft/textures/item/bow_pulling_1.png": solid16(120, 70, 40),
      "assets/minecraft/textures/item/bow_pulling_2.png": solid16(130, 75, 45),
    });

    const result = await convertPack(zip, { packName: "Bow3D" });
    // Should report as skipped due to non-sprite model.
    const entry = result.report.entries.find(
      (e) => e.stage === "bow-pull" && e.status === "skipped",
    );
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain("not a sprite");
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
