import type { JavaElement, JavaFaceName } from "../java/model.js";
import type { AtlasPlacement } from "../image/atlas.js";

/**
 * Java block-model element → Bedrock geometry conversion.
 *
 * Coordinate mapping (matches java2bedrock.sh, which Geyser packs use in the wild):
 *   origin = [8 - to.x, from.y, from.z - 8]
 *   size   = to - from
 *   pivot  = [8 - rot.origin.x, rot.origin.y, rot.origin.z - 8]
 *   rotation: x-axis → [-angle,0,0], y-axis → [0,-angle,0], z-axis → [0,0,angle]
 * Cubes hang off a bone chain geysercmd → _x → _y → _z (pivot [0,8,0]) so that
 * Java display-transform rotations can be applied per-axis in the right order.
 */

interface BedrockFaceUv {
  uv: [number, number];
  uv_size: [number, number];
}

interface BedrockCube {
  origin: [number, number, number];
  size: [number, number, number];
  pivot?: [number, number, number];
  rotation?: [number, number, number];
  uv: Partial<Record<JavaFaceName, BedrockFaceUv>>;
}

export interface GeometryBuild {
  geometry: object;
  /** True if any face used a UV rotation (requires newer format on the client). */
  usedUvRotation: boolean;
}

export const BONE_ROOT = "geysercmd";
export const BONE_X = "geysercmd_x";
export const BONE_Y = "geysercmd_y";
export const BONE_Z = "geysercmd_z";

export function buildGeometry(
  identifier: string,
  elements: JavaElement[],
  faceTexture: (element: JavaElement, face: JavaFaceName) => AtlasPlacement | undefined,
  atlasSize: { width: number; height: number },
): GeometryBuild {
  let usedUvRotation = false;
  const cubes: BedrockCube[] = [];

  for (const element of elements) {
    let { from, to } = element;
    // Java "rescale: true" scales the element by 1/cos(angle) on the axes
    // perpendicular to the rotation axis (about the rotation origin). Bedrock
    // has no rescale flag, so bake the scaling into the cube coordinates.
    if (element.rotation?.rescale === true && element.rotation.angle !== 0) {
      const f = 1 / Math.cos((Math.abs(element.rotation.angle) * Math.PI) / 180);
      const o = element.rotation.origin;
      const axisIndex = { x: 0, y: 1, z: 2 }[element.rotation.axis];
      const scaleCoord = (v: [number, number, number]): [number, number, number] =>
        v.map((c, i) => (i === axisIndex ? c : o[i]! + (c - o[i]!) * f)) as [number, number, number];
      from = scaleCoord(from);
      to = scaleCoord(to);
    }
    const cube: BedrockCube = {
      origin: [8 - to[0], from[1], from[2] - 8],
      size: [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
      uv: {},
    };

    // Guard against models with a rotation object but missing/zero angle —
    // emitting null/NaN in the rotation array makes Bedrock reject the whole
    // geometry (renders invisible).
    const angle = element.rotation?.angle ?? 0;
    if (element.rotation !== undefined && angle !== 0 && Number.isFinite(angle)) {
      const { origin, axis } = element.rotation;
      cube.pivot = [8 - origin[0], origin[1], origin[2] - 8];
      cube.rotation =
        axis === "x" ? [-angle, 0, 0] : axis === "y" ? [0, -angle, 0] : [0, 0, angle];
    }

    for (const faceName of ["north", "south", "east", "west", "up", "down"] as JavaFaceName[]) {
      const face = element.faces?.[faceName];
      if (face === undefined) continue;
      const placement = faceTexture(element, faceName);
      if (placement === undefined) continue;

      // Default UVs derive from the unscaled element bounds (rescale moves
      // vertices, not texture coordinates).
      const uv16 = face.uv ?? defaultUv(faceName, element.from, element.to);
      // Java UV is 0–16 per texture; scale into the texture's own pixels, then
      // offset by its tile position in the atlas.
      const sx = placement.width / 16;
      const sy = placement.height / 16;
      let [u1, v1, u2, v2] = uv16;
      const bedrockUv: BedrockFaceUv & { uv_rotation?: number } = {
        uv: [placement.x + u1 * sx, placement.y + v1 * sy],
        uv_size: [(u2 - u1) * sx, (v2 - v1) * sy],
      };
      if (face.rotation !== undefined && face.rotation !== 0) {
        bedrockUv.uv_rotation = face.rotation;
        usedUvRotation = true;
      }
      cube.uv[faceName] = bedrockUv;
    }
    cubes.push(cube);
  }

  const geometry = {
    format_version: usedUvRotation ? "1.21.0" : "1.16.0",
    "minecraft:geometry": [
      {
        description: {
          identifier,
          texture_width: atlasSize.width,
          texture_height: atlasSize.height,
          visible_bounds_width: 4,
          visible_bounds_height: 4.5,
          visible_bounds_offset: [0, 0.75, 0],
        },
        bones: [
          {
            name: BONE_ROOT,
            binding: "c.item_slot == 'head' ? 'head' : q.item_slot_to_bone_name(c.item_slot)",
            pivot: [0, 8, 0],
          },
          { name: BONE_X, parent: BONE_ROOT, pivot: [0, 8, 0] },
          { name: BONE_Y, parent: BONE_X, pivot: [0, 8, 0] },
          { name: BONE_Z, parent: BONE_Y, pivot: [0, 8, 0], cubes },
        ],
      },
    ],
  };

  return { geometry, usedUvRotation };
}

/** Vanilla default UVs derived from element bounds (Java behaviour when face.uv is omitted). */
export function defaultUv(
  face: JavaFaceName,
  from: [number, number, number],
  to: [number, number, number],
): [number, number, number, number] {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;
  switch (face) {
    case "down":
      return [x1, 16 - z2, x2, 16 - z1];
    case "up":
      return [x1, z1, x2, z2];
    case "north":
      return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case "south":
      return [x1, 16 - y2, x2, 16 - y1];
    case "west":
      return [z1, 16 - y2, z2, 16 - y1];
    case "east":
      return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
  }
}
