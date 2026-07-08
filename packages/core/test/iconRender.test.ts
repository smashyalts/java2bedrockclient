import { describe, expect, it } from "vitest";
import { renderModelIcon } from "../src/image/modelRender.js";
import { alphaBleed, createImage } from "../src/image/png.js";
import type { JavaElement } from "../src/java/model.js";

function solidTexture(r: number, g: number, b: number) {
  const image = createImage(16, 16);
  for (let i = 0; i < 16 * 16; i++) image.data.set([r, g, b, 255], i * 4);
  return image;
}

const CUBE: JavaElement = {
  from: [0, 0, 0],
  to: [16, 16, 16],
  faces: {
    up: { texture: "#a", uv: [0, 0, 16, 16] },
    north: { texture: "#a", uv: [0, 0, 16, 16] },
    south: { texture: "#a", uv: [0, 0, 16, 16] },
    east: { texture: "#a", uv: [0, 0, 16, 16] },
    west: { texture: "#a", uv: [0, 0, 16, 16] },
    down: { texture: "#a", uv: [0, 0, 16, 16] },
  },
};

describe("model icon renderer", () => {
  it("renders a cube with isometric shading and transparent background", () => {
    const tex = solidTexture(200, 100, 50);
    const icon = renderModelIcon([CUBE], () => ({ image: tex, uv: [0, 0, 16, 16] }), undefined, 64);

    // Center pixel opaque.
    const center = (32 * 64 + 32) * 4;
    expect(icon.data[center + 3]).toBe(255);
    // Corners transparent (icon fits with margin).
    expect(icon.data[3]).toBe(0);
    // Multiple shade levels visible (top face brighter than sides).
    const alphas = new Set<number>();
    for (let i = 0; i < 64 * 64; i++) {
      if (icon.data[i * 4 + 3]! > 0) alphas.add(icon.data[i * 4]!);
    }
    expect(alphas.size).toBeGreaterThanOrEqual(2);
  });

  it("alphaBleed copies edge colours into transparent pixels without changing alpha", () => {
    const img = createImage(4, 4);
    // single red opaque pixel at (1,1)
    img.data.set([255, 0, 0, 255], (1 * 4 + 1) * 4);
    alphaBleed(img);
    // neighbour (2,1) got red RGB but stayed transparent
    const i = (1 * 4 + 2) * 4;
    expect(img.data[i]).toBe(255);
    expect(img.data[i + 3]).toBe(0);
    // original pixel untouched
    expect(img.data[(1 * 4 + 1) * 4 + 3]).toBe(255);
  });
});
