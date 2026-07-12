import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { convertPack, readZip } from "../src/index.js";
import { decodePng } from "../src/image/png.js";

function fixtureZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(tree);
}

function chestPng(fill: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) data.set(fill, i * 4);
  return new Uint8Array(encode({ width: 64, height: 64, data, channels: 4 }));
}

describe("entity composites", () => {
  it("rearranges single chests and stitches double chests for Bedrock", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }),
      "assets/minecraft/textures/entity/chest/normal.png": chestPng([100, 50, 20, 255]),
      "assets/minecraft/textures/entity/chest/normal_left.png": chestPng([120, 60, 30, 255]),
      "assets/minecraft/textures/entity/chest/normal_right.png": chestPng([90, 45, 15, 255]),
    });

    const result = await convertPack(zip, { packName: "Chests" });
    const out = readZip(result.mcpack);

    // Single chest rewritten in place, still 64x64.
    const single = decodePng(out.read("textures/entity/chest/normal.png")!);
    expect(single.width).toBe(64);
    expect(single.height).toBe(64);

    // Double chest stitched to one 128x64 sheet; halves removed.
    const double = decodePng(out.read("textures/entity/chest/double_normal.png")!);
    expect(double.width).toBe(128);
    expect(double.height).toBe(64);
    expect(out.has("textures/entity/chest/normal_left.png")).toBe(false);
    expect(out.has("textures/entity/chest/normal_right.png")).toBe(false);

    const entries = result.report.entries.filter((e) => e.stage === "entity-composites");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((e) => e.status === "converted")).toBe(true);
  });

  it("leaves pre-1.15 chest layouts untouched", async () => {
    const zip = fixtureZip({
      "pack.mcmeta": JSON.stringify({ pack: { pack_format: 4 } }),
      "assets/minecraft/textures/entity/chest/normal.png": chestPng([100, 50, 20, 255]),
    });
    const result = await convertPack(zip, { packName: "OldChests" });
    expect(result.report.entries.some((e) => e.stage === "entity-composites")).toBe(false);
  });
});
