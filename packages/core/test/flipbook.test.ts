import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { convertPack, readZip } from "../src/index.js";

/** Vertical strip: N 16x16 frames, each a solid colour. */
function strip(frames: number): Uint8Array {
  const data = new Uint8Array(16 * 16 * frames * 4);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < 16 * 16; i++) {
      data.set([f * 30, 255 - f * 30, 40, 255], (f * 16 * 16 + i) * 4);
    }
  }
  return new Uint8Array(encode({ width: 16, height: 16 * frames, data, channels: 4 }));
}

function fixtureZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(tree);
}

const MODEL = {
  textures: { body: "custom:item/anim_body" },
  elements: [
    {
      from: [4, 0, 4],
      to: [12, 16, 12],
      faces: {
        north: { uv: [0, 0, 16, 16], texture: "#body" },
        south: { uv: [0, 0, 16, 16], texture: "#body" },
      },
    },
  ],
};

describe("flipbook item animation", () => {
  it("emits per-frame atlases and a time-indexed render controller", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/stick.json": JSON.stringify({
        parent: "minecraft:item/handheld",
        textures: { layer0: "minecraft:item/stick" },
        overrides: [{ predicate: { custom_model_data: 1 }, model: "custom:item/anim_wand" }],
      }),
      "assets/custom/models/item/anim_wand.json": JSON.stringify(MODEL),
      "assets/custom/textures/item/anim_body.png": strip(4),
      "assets/custom/textures/item/anim_body.png.mcmeta": JSON.stringify({ animation: { frametime: 5 } }),
    });

    const result = await convertPack(zip, { packName: "Anim" });
    const out = readZip(result.mcpack);
    const base = "textures/geyser_custom/atlases/custom_item_anim_wand";
    expect(out.has(base + ".png")).toBe(true);
    expect(out.has(base + "_f1.png")).toBe(true);
    expect(out.has(base + "_f3.png")).toBe(true);
    expect(out.has(base + "_f4.png")).toBe(false); // 4 frames total

    const rc = JSON.parse(
      out.readText("render_controllers/geyser_custom/custom_item_anim_wand.render_controllers.json")!,
    );
    const controller = rc.render_controllers["controller.render.gc_custom_item_anim_wand"];
    expect(controller.arrays.textures["Array.frames"]).toEqual([
      "Texture.default",
      "Texture.frame1",
      "Texture.frame2",
      "Texture.frame3",
    ]);
    // frametime 5 ticks → 4 fps
    expect(controller.textures[0]).toBe("Array.frames[math.mod(math.floor(q.life_time * 4), 4)]");

    const attachable = JSON.parse(out.readText("attachables/geyser_custom/custom_item_anim_wand.json")!);
    const desc = attachable["minecraft:attachable"].description;
    expect(desc.render_controllers).toEqual(["controller.render.gc_custom_item_anim_wand"]);
    expect(desc.textures.frame2).toBe(base + "_f2");

    // Report marks it converted with animation info, not approximated.
    const entry = result.report.entries.find(
      (e) => e.stage === "items-3d" && e.source === "custom:item/anim_wand" && e.status === "converted",
    );
    expect(entry).toBeDefined();
    expect(entry!.outputs!.some((o) => o.includes("animated: 4 frames"))).toBe(true);
  });

  it("keeps full animations by default (no cap)", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/stick.json": JSON.stringify({
        parent: "minecraft:item/handheld",
        textures: { layer0: "minecraft:item/stick" },
        overrides: [{ predicate: { custom_model_data: 1 }, model: "custom:item/full_anim" }],
      }),
      "assets/custom/models/item/full_anim.json": JSON.stringify({
        ...MODEL,
        textures: { body: "custom:item/full_body" },
      }),
      "assets/custom/textures/item/full_body.png": strip(30),
      "assets/custom/textures/item/full_body.png.mcmeta": JSON.stringify({ animation: { frametime: 1 } }),
    });
    const result = await convertPack(zip, { packName: "Full" });
    const out = readZip(result.mcpack);
    expect(out.list({ prefix: "textures/geyser_custom/atlases/" }).length).toBe(30);
    const entry = result.report.entries.find((e) => e.source === "custom:item/full_anim");
    expect(entry!.outputs!.some((o) => o.includes("animated: 30 frames"))).toBe(true);
  });

  it("subsamples very long flipbooks when a frame cap is set", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/models/item/stick.json": JSON.stringify({
        parent: "minecraft:item/handheld",
        textures: { layer0: "minecraft:item/stick" },
        overrides: [{ predicate: { custom_model_data: 1 }, model: "custom:item/long_anim" }],
      }),
      "assets/custom/models/item/long_anim.json": JSON.stringify({
        ...MODEL,
        textures: { body: "custom:item/long_body" },
      }),
      "assets/custom/textures/item/long_body.png": strip(60),
      "assets/custom/textures/item/long_body.png.mcmeta": JSON.stringify({ animation: { frametime: 1 } }),
    });
    const result = await convertPack(zip, { packName: "Long", maxAnimationFrames: 20 });
    const out = readZip(result.mcpack);
    const frames = out.list({ prefix: "textures/geyser_custom/atlases/" }).length;
    expect(frames).toBe(20); // capped
    const entry = result.report.entries.find((e) => e.source === "custom:item/long_anim");
    expect(entry!.outputs!.some((o) => o.includes("subsampled from 60"))).toBe(true);
  });
});
