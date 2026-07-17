import { describe, expect, it } from "vitest";
import { buildGeometry } from "../src/bedrock/geometry.js";
import type { JavaElement } from "../src/java/model.js";

const placement = { x: 0, y: 0, width: 16, height: 16 };
const faceTexture = () => placement;

/** A "string" bar at the front (z 0..2) and "limbs" at the back (z 14..16). */
const elements: JavaElement[] = [
  { from: [4, 0, 0], to: [12, 4, 2], faces: { up: { texture: "#t" } } } as JavaElement,
  { from: [4, 0, 14], to: [12, 4, 16], faces: { up: { texture: "#t" } } } as JavaElement,
];

function cubesOf(geo: object): { origin: number[]; size: number[]; rotation?: number[] }[] {
  return (geo as any)["minecraft:geometry"][0].bones.at(-1).cubes;
}

describe("geometry facing flip (crossbow)", () => {
  it("leaves geometry unchanged without flipFacing", () => {
    const { geometry } = buildGeometry("geometry.x", elements, faceTexture, { width: 16, height: 16 });
    const cubes = cubesOf(geometry);
    // origin.z = from.z - 8 → front bar at -8, back bar at 6.
    expect(cubes[0]!.origin[2]).toBe(-8);
    expect(cubes[1]!.origin[2]).toBe(6);
  });

  it("turns a Y-rotated cube by +180° so splayed limbs re-aim (not just reposition)", () => {
    // A limb splayed by a Java Y-axis rotation. buildGeometry stores it as a
    // bedrock cube rotation [0, -angle, 0]; a 180° flip must add 180° to that Y
    // angle, otherwise the limb stays pointing the original way and the whole
    // model reads as 180° off (the crossbow-facing-backward symptom).
    const limb: JavaElement[] = [
      {
        from: [4, 0, 0],
        to: [12, 4, 2],
        rotation: { angle: 22.5, axis: "y", origin: [8, 2, 1] },
        faces: { up: { texture: "#t" } },
      } as JavaElement,
    ];
    const flat = buildGeometry("geometry.x", limb, faceTexture, { width: 16, height: 16 });
    const flipped = buildGeometry("geometry.x", limb, faceTexture, { width: 16, height: 16 }, { flipFacing: true });
    // Java +22.5° about Y → bedrock [0, -22.5, 0].
    expect(cubesOf(flat.geometry)[0]!.rotation).toEqual([0, -22.5, 0]);
    // +180° → -22.5 + 180 = 157.5.
    expect(cubesOf(flipped.geometry)[0]!.rotation).toEqual([0, 157.5, 0]);
  });

  it("swaps front and back when flipFacing is set (180° about Y)", () => {
    const { geometry } = buildGeometry(
      "geometry.x",
      elements,
      faceTexture,
      { width: 16, height: 16 },
      { flipFacing: true },
    );
    const cubes = cubesOf(geometry);
    // Reflected about the horizontal centre: the front bar moves to the back
    // and vice versa; sizes unchanged.
    expect(cubes[0]!.origin[2]).toBe(6);
    expect(cubes[1]!.origin[2]).toBe(-8);
    expect(cubes[0]!.size).toEqual([8, 4, 2]);
    // X is also reflected (180° about Y), but the bars are X-centred so X is unchanged.
    expect(cubes[0]!.origin[0]).toBe(cubes[1]!.origin[0]);
  });
});
