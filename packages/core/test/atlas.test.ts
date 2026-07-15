import { describe, expect, it } from "vitest";
import { buildAtlas } from "../src/image/atlas.js";
import { createImage, type RgbaImage } from "../src/image/png.js";

function solid(size: number, rgba: [number, number, number, number]): RgbaImage {
  const img = createImage(size, size);
  for (let i = 0; i < size * size; i++) img.data.set(rgba, i * 4);
  return img;
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("atlas packing", () => {
  it("reproduces the max-tile grid for uniform sizes", () => {
    const atlas = buildAtlas(
      new Map([
        ["a", solid(16, [255, 0, 0, 255])],
        ["b", solid(16, [0, 255, 0, 255])],
      ]),
    );
    // Two 16px tiles pack side by side, exactly like the old grid.
    expect(atlas.image.width).toBe(32);
    expect(atlas.image.height).toBe(16);
  });

  it("shrinks mixed-size atlases below the max-tile grid, no overlap or clipping", () => {
    const textures = new Map<string, RgbaImage>([
      ["big", solid(32, [200, 50, 50, 255])],
      ["s1", solid(16, [50, 200, 50, 255])],
      ["s2", solid(16, [50, 50, 200, 255])],
    ]);
    const atlas = buildAtlas(textures);

    // Old grid would be 2x2 tiles of 32px = 64x64; the shelf packer avoids
    // padding the 16px tiles to 32px rows.
    expect(atlas.image.height).toBeLessThan(64);
    expect(atlas.image.width * atlas.image.height).toBeLessThan(64 * 64);

    const places = [...atlas.placements.values()];
    // Every placement fits inside the atlas.
    for (const p of places) {
      expect(p.x + p.width).toBeLessThanOrEqual(atlas.image.width);
      expect(p.y + p.height).toBeLessThanOrEqual(atlas.image.height);
    }
    // No two placements overlap.
    for (let i = 0; i < places.length; i++) {
      for (let j = i + 1; j < places.length; j++) {
        expect(overlaps(places[i]!, places[j]!)).toBe(false);
      }
    }
    // Each texture's top-left pixel landed at its placement (blit is correct).
    for (const [id, p] of atlas.placements) {
      const src = textures.get(id)!;
      const di = (p.y * atlas.image.width + p.x) * 4;
      expect([...atlas.image.data.slice(di, di + 4)]).toEqual([...src.data.slice(0, 4)]);
    }
  });

  it("packs a single texture as itself", () => {
    const atlas = buildAtlas(new Map([["only", solid(24, [1, 2, 3, 255])]]));
    expect(atlas.image.width).toBe(24);
    expect(atlas.image.height).toBe(24);
    expect(atlas.placements.get("only")).toEqual({ x: 0, y: 0, width: 24, height: 24 });
  });
});
