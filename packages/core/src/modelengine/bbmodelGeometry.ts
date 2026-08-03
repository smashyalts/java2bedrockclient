import type { BbModel, BbElement, BbGroup, BbFaceName } from "./bbmodel.js";
import { isCube } from "./bbmodel.js";

/**
 * Convert a bbmodel to a Bedrock entity geometry (`minecraft:geometry`).
 *
 * Bones come from the `outliner` tree (each group → a bone, parented to its
 * enclosing group). Cubes are the elements a group directly contains. Blockbench
 * model space is mirrored on X relative to Bedrock, so every X coordinate is
 * negated (origin, pivot) and X/Y rotations flip sign — the same transform our
 * item geometry uses, minus the item-only [8,·,8] hand-centering offset (entity
 * models are authored around the entity origin). Face UVs are already in the
 * model's `resolution` space, which we publish as texture_width/height, so they
 * map straight through.
 */
export interface BedrockGeometry {
  format_version: string;
  "minecraft:geometry": [
    {
      description: {
        identifier: string;
        texture_width: number;
        texture_height: number;
        visible_bounds_width: number;
        visible_bounds_height: number;
        visible_bounds_offset: [number, number, number];
      };
      bones: BedrockBone[];
    },
  ];
}

interface BedrockBone {
  name: string;
  parent?: string;
  pivot: [number, number, number];
  rotation?: [number, number, number];
  cubes?: BedrockCube[];
}

interface BedrockCube {
  origin: [number, number, number];
  size: [number, number, number];
  pivot?: [number, number, number];
  rotation?: [number, number, number];
  inflate?: number;
  uv: Partial<Record<BbFaceName, { uv: [number, number]; uv_size: [number, number] }>>;
}

const FACE_NAMES: BbFaceName[] = ["north", "south", "east", "west", "up", "down"];

/** Geometry plus a bbmodel-group-uuid → final bone name map, so the animation
 * converter (whose animators are keyed by bone uuid) targets the same names. */
export interface GeometryBuild {
  geometry: BedrockGeometry;
  boneNames: Map<string, string>;
  /** Bone name → the texture indices its cubes sample (for binding_bones). */
  boneTextures: Map<string, Set<number>>;
}

export function bbmodelToGeometry(model: BbModel, identifier: string): GeometryBuild {
  const resW = model.resolution?.width && model.resolution.width > 0 ? model.resolution.width : 16;
  const resH = model.resolution?.height && model.resolution.height > 0 ? model.resolution.height : 16;

  const elementsById = new Map<string, BbElement>();
  for (const el of model.elements ?? []) elementsById.set(el.uuid, el);

  const bones: BedrockBone[] = [];
  const usedNames = new Set<string>();
  const boneNames = new Map<string, string>();
  const boneTextures = new Map<string, Set<number>>();
  let minY = 0;
  let maxY = 0;
  let maxHoriz = 4;

  const walk = (node: BbGroup, parentName: string | undefined): void => {
    const boneName = uniqueBone(node.name, node.uuid, usedNames);
    boneNames.set(node.uuid, boneName);
    const pivot = mirror(node.origin ?? [0, 0, 0]);
    const bone: BedrockBone = { name: boneName, pivot };
    if (parentName !== undefined) bone.parent = parentName;
    const rot = boneRotation(node.rotation);
    if (rot !== undefined) bone.rotation = rot;

    const texSet = new Set<number>();
    const cubes: BedrockCube[] = [];
    for (const child of node.children ?? []) {
      if (typeof child === "string") {
        const el = elementsById.get(child);
        if (el !== undefined && isCube(el)) {
          for (const f of Object.values(el.faces ?? {})) {
            if (typeof f?.texture === "number") texSet.add(f.texture);
          }
          const cube = elementToCube(el, resW, resH);
          if (cube !== undefined) {
            cubes.push(cube);
            minY = Math.min(minY, cube.origin[1]);
            maxY = Math.max(maxY, cube.origin[1] + cube.size[1]);
            maxHoriz = Math.max(
              maxHoriz,
              Math.abs(cube.origin[0]),
              Math.abs(cube.origin[0] + cube.size[0]),
              Math.abs(cube.origin[2]),
              Math.abs(cube.origin[2] + cube.size[2]),
            );
          }
        }
      } else {
        walk(child, boneName);
      }
    }
    if (cubes.length > 0) bone.cubes = cubes;
    if (texSet.size > 0) boneTextures.set(boneName, texSet);
    bones.push(bone);
  };

  for (const node of model.outliner ?? []) {
    if (typeof node === "string") {
      // A loose element at the root with no bone — wrap it in a root bone.
      const el = elementsById.get(node);
      if (el !== undefined && isCube(el)) {
        const cube = elementToCube(el, resW, resH);
        if (cube !== undefined) {
          let root = bones.find((b) => b.name === "root");
          if (root === undefined) {
            root = { name: "root", pivot: [0, 0, 0], cubes: [] };
            bones.push(root);
          }
          (root.cubes ??= []).push(cube);
        }
      }
    } else {
      walk(node, undefined);
    }
  }

  const geometry: BedrockGeometry = {
    format_version: "1.16.0",
    "minecraft:geometry": [
      {
        description: {
          identifier,
          texture_width: resW,
          texture_height: resH,
          visible_bounds_width: Math.max(4, Math.ceil((maxHoriz * 2) / 16) + 1),
          visible_bounds_height: Math.max(4, Math.ceil((maxY - minY) / 16) + 1),
          visible_bounds_offset: [0, (minY + maxY) / 32, 0],
        },
        bones,
      },
    ],
  };
  return { geometry, boneNames, boneTextures };
}

/** Mirror a point on X (Blockbench → Bedrock handedness). */
function mirror(p: [number, number, number]): [number, number, number] {
  return [-p[0], p[1], p[2]];
}

/** Bedrock bone rotation from a bbmodel euler (X,Y flip sign under X-mirror). */
function boneRotation(
  rot: [number, number, number] | undefined,
): [number, number, number] | undefined {
  if (rot === undefined || rot.every((a) => a === 0)) return undefined;
  return [-rot[0], -rot[1], rot[2]];
}

function elementToCube(el: BbElement, resW: number, resH: number): BedrockCube | undefined {
  const from = el.from!;
  const to = el.to!;
  // Mirror X: the bedrock origin is the mirrored min-corner, so it uses -to.x.
  const cube: BedrockCube = {
    origin: [-to[0], from[1], from[2]],
    size: [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
    uv: {},
  };
  if (el.inflate !== undefined && el.inflate !== 0) cube.inflate = el.inflate;
  const rot = boneRotation(el.rotation);
  if (rot !== undefined || (el.origin !== undefined && el.rotation !== undefined)) {
    cube.pivot = mirror(el.origin ?? [0, 0, 0]);
    if (rot !== undefined) cube.rotation = rot;
  }
  for (const faceName of FACE_NAMES) {
    const face = el.faces?.[faceName];
    if (face?.uv === undefined) continue;
    const [u1, v1, u2, v2] = face.uv;
    // bbmodel uv is already in resolution (texture_width/height) space.
    cube.uv[faceName] = { uv: [u1, v1], uv_size: [u2 - u1, v2 - v1] };
  }
  void resW;
  void resH;
  return cube;
}

/** Sanitize a bone name and guarantee uniqueness within the geometry. */
function uniqueBone(name: string | undefined, uuid: string, used: Set<string>): string {
  const base =
    (name ?? "bone")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || `bone_${uuid.slice(0, 8)}`;
  let candidate = base;
  for (let i = 2; used.has(candidate); i++) candidate = `${base}_${i}`;
  used.add(candidate);
  return candidate;
}
