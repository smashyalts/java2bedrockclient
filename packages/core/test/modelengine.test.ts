import { describe, expect, it } from "vitest";
import { encode } from "fast-png";
import { VirtualFs } from "../src/io/vfs.js";
import { buildModelEngineInput } from "../src/modelengine/modelEngineInput.js";

/** 2×2 red PNG as a base64 data URI (bbmodel embeds textures this way). */
function pngDataUri(): string {
  const data = new Uint8Array(2 * 2 * 4).fill(255);
  const bytes = encode({ width: 2, height: 2, data, channels: 4 });
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "data:image/png;base64," + btoa(bin);
}

/** A minimal two-bone, one-animation bbmodel (resolution 32). */
function bbmodel(): string {
  const bodyUuid = "11111111-1111-1111-1111-111111111111";
  const wingUuid = "22222222-2222-2222-2222-222222222222";
  const bodyBone = "aaaaaaaa-0000-0000-0000-000000000000";
  const wingBone = "bbbbbbbb-0000-0000-0000-000000000000";
  return JSON.stringify({
    name: "test_drone",
    resolution: { width: 32, height: 32 },
    elements: [
      {
        uuid: bodyUuid,
        type: "cube",
        from: [-2, 10, -2],
        to: [2, 14, 2],
        origin: [0, 12, 0],
        faces: { north: { uv: [0, 0, 4, 4], texture: 0 }, up: { uv: [0, 0, 4, 4], texture: 0 } },
      },
      {
        uuid: wingUuid,
        type: "cube",
        from: [2, 11, -1],
        to: [6, 12, 1],
        origin: [2, 11, 0],
        rotation: [0, 0, 20],
        faces: { up: { uv: [4, 4, 8, 8], texture: 1 } },
      },
    ],
    outliner: [
      {
        uuid: bodyBone,
        name: "body",
        origin: [0, 12, 0],
        children: [bodyUuid, { uuid: wingBone, name: "wing", origin: [2, 11, 0], children: [wingUuid] }],
      },
    ],
    textures: [
      { name: "body.png", width: 32, height: 32, source: pngDataUri() },
      { name: "wing.png", width: 32, height: 32, source: pngDataUri() },
    ],
    animations: [
      {
        name: "idle",
        loop: "loop",
        length: 1,
        animators: {
          [bodyBone]: {
            name: "body",
            keyframes: [
              { channel: "rotation", time: 0, data_points: [{ x: 10, y: 5, z: 2 }] },
              { channel: "position", time: 0.5, data_points: [{ x: 1, y: 2, z: 3 }] },
            ],
          },
        },
      },
    ],
  });
}

describe("ModelEngine bbmodel conversion", () => {
  it("converts a bbmodel to a GeyserModelEngine input bundle", () => {
    const vfs = new VirtualFs();
    vfs.writeText("ModelEngine/blueprints/test_drone.bbmodel", bbmodel());
    const r = buildModelEngineInput(vfs);

    expect(r.failed).toEqual([]);
    expect(r.models).toHaveLength(1);
    expect(r.models[0]!.id).toBe("test_drone");

    // Geometry: bone hierarchy preserved, cube mirrored on X, UVs in resolution space.
    const geo = JSON.parse(decode(r.files.get("input/test_drone/test_drone.geo.json")!));
    const g = geo["minecraft:geometry"][0];
    expect(g.description.texture_width).toBe(32);
    const bones = g.bones as { name: string; parent?: string; cubes?: unknown[] }[];
    const body = bones.find((b) => b.name === "body")!;
    const wing = bones.find((b) => b.name === "wing")!;
    expect(wing.parent).toBe("body");
    const cube = (body.cubes as { origin: number[]; size: number[]; uv: Record<string, { uv: number[]; uv_size: number[] }> }[])[0]!;
    // from[-2,10,-2] to[2,14,2] → origin = [-to.x, from.y, from.z] = [-2,10,-2], size [4,4,4].
    expect(cube.origin).toEqual([-2, 10, -2]);
    expect(cube.size).toEqual([4, 4, 4]);
    expect(cube.uv.north!.uv).toEqual([0, 0]);
    expect(cube.uv.north!.uv_size).toEqual([4, 4]);
    // wing has z-rotation 20 → kept as-is on Z.
    const wingCube = (wing.cubes as { rotation?: number[] }[])[0]!;
    expect(wingCube.rotation).toEqual([0, 0, 20]);

    // config.json: per-texture uv sizes = resolution; binding_bones maps textures to bones.
    const cfg = JSON.parse(decode(r.files.get("input/test_drone/config.json")!));
    expect(cfg.per_texture_uv_size.body).toEqual([32, 32]);
    expect(cfg.binding_bones.wing).toContain("wing");
    expect(cfg.binding_bones.body).toContain("body");

    // Animation: rotation negates X/Y, position negates X.
    const anim = JSON.parse(decode(r.files.get("input/test_drone/test_drone.animation.json")!));
    const a = anim.animations["animation.test_drone.idle"];
    expect(a.loop).toBe(true);
    expect(a.bones.body.position["0.5"]).toEqual([-1, 2, 3]);
    expect(a.bones.body.rotation["0"]).toEqual([-10, -5, 2]);
  });
});

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
