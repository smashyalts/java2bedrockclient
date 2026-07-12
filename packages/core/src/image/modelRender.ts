import type { JavaElement, JavaFaceName } from "../java/model.js";
import type { JavaDisplayTransform } from "../java/model.js";
import { createImage, type RgbaImage } from "./png.js";
import { timeOp } from "../report/timings.js";

/**
 * Tiny software renderer producing inventory icons for 3D models: orthographic
 * projection, painter's algorithm, nearest-neighbour texture sampling, and
 * Minecraft-style per-axis face shading. Runs anywhere (no canvas/GPU).
 */

export interface FaceTextureLookup {
  (element: JavaElement, face: JavaFaceName): { image: RgbaImage; uv: [number, number, number, number] } | undefined;
}

type Vec3 = [number, number, number];

const FACE_SHADE: Record<JavaFaceName, number> = {
  up: 1.0,
  down: 0.5,
  north: 0.8,
  south: 0.8,
  east: 0.6,
  west: 0.6,
};

/** Corner order per face: matches Java UV orientation (u1v1 = top-left of the face texture). */
function faceCorners(face: JavaFaceName, from: Vec3, to: Vec3): [Vec3, Vec3, Vec3, Vec3] {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;
  switch (face) {
    case "north": return [[x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1]];
    case "south": return [[x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2]];
    case "west":  return [[x1, y2, z1], [x1, y2, z2], [x1, y1, z2], [x1, y1, z1]];
    case "east":  return [[x2, y2, z2], [x2, y2, z1], [x2, y1, z1], [x2, y1, z2]];
    case "up":    return [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]];
    case "down":  return [[x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1]];
  }
}

function rotate(v: Vec3, axis: "x" | "y" | "z", degrees: number, origin: Vec3): Vec3 {
  const rad = (degrees * Math.PI) / 180;
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const [ox, oy, oz] = origin;
  const [x, y, z] = [v[0] - ox, v[1] - oy, v[2] - oz];
  let out: Vec3;
  if (axis === "x") out = [x, y * c - z * s, y * s + z * c];
  else if (axis === "y") out = [x * c + z * s, y, -x * s + z * c];
  else out = [x * c - y * s, x * s + y * c, z];
  return [out[0] + ox, out[1] + oy, out[2] + oz];
}

interface ProjectedFace {
  pts: [number, number][]; // screen space
  depth: number;
  uv: [number, number, number, number];
  image: RgbaImage;
  shade: number;
}

/**
 * Render a model to a square icon. Uses the model's gui display rotation when
 * present, otherwise the vanilla block GUI view (30°/225°).
 */
export function renderModelIcon(
  elements: JavaElement[],
  lookup: FaceTextureLookup,
  guiDisplay: JavaDisplayTransform | undefined,
  size = 64,
): RgbaImage {
  return timeOp("icon.render", () => renderModelIconUntimed(elements, lookup, guiDisplay, size));
}

function renderModelIconUntimed(
  elements: JavaElement[],
  lookup: FaceTextureLookup,
  guiDisplay: JavaDisplayTransform | undefined,
  size: number,
): RgbaImage {
  const rotationDeg = guiDisplay?.rotation ?? [30, 225, 0];
  const center: Vec3 = [8, 8, 8];

  const faces: ProjectedFace[] = [];
  for (const element of elements) {
    for (const faceName of Object.keys(element.faces ?? {}) as JavaFaceName[]) {
      const tex = lookup(element, faceName);
      if (tex === undefined) continue;
      let corners = faceCorners(faceName, element.from, element.to);
      if (element.rotation !== undefined) {
        corners = corners.map((p) =>
          rotate(p, element.rotation!.axis, element.rotation!.angle, element.rotation!.origin),
        ) as typeof corners;
      }
      // Java display rotation: R = Rx·Ry·Rz applied to the point (Z first),
      // matching vanilla ItemTransform (verified against in-game GUI renders).
      const viewed = corners.map((p) => {
        let v = rotationDeg[2] !== 0 ? rotate(p, "z", rotationDeg[2], center) : p;
        v = rotate(v, "y", rotationDeg[1], center);
        v = rotate(v, "x", rotationDeg[0], center);
        return v;
      });
      faces.push({
        pts: viewed.map((v) => [v[0], v[1]] as [number, number]),
        depth: viewed.reduce((acc, v) => acc + v[2], 0) / 4,
        uv: tex.uv,
        image: tex.image,
        shade: FACE_SHADE[faceName],
      });
    }
  }

  const icon = createImage(size, size);
  if (faces.length === 0) return icon;

  // Fit projected bounds into the canvas with a small margin.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of faces) {
    for (const [x, y] of f.pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = (size * 0.92) / span;
  const offX = (size - (maxX - minX) * scale) / 2;
  const offY = (size - (maxY - minY) * scale) / 2;
  const toScreen = ([x, y]: [number, number]): [number, number] => [
    (x - minX) * scale + offX,
    size - ((y - minY) * scale + offY), // flip Y (raster space)
  ];

  // Painter's algorithm: farthest (lowest z) first.
  faces.sort((a, b) => a.depth - b.depth);

  for (const face of faces) {
    const p = face.pts.map(toScreen);
    // Two triangles: 0-1-2 and 0-2-3, with UV corners (u1,v1)(u2,v1)(u2,v2)(u1,v2).
    const [u1, v1, u2, v2] = face.uv;
    const uvs: [number, number][] = [[u1, v1], [u2, v1], [u2, v2], [u1, v2]];
    drawTriangle(icon, [p[0]!, p[1]!, p[2]!], [uvs[0]!, uvs[1]!, uvs[2]!], face.image, face.shade);
    drawTriangle(icon, [p[0]!, p[2]!, p[3]!], [uvs[0]!, uvs[2]!, uvs[3]!], face.image, face.shade);
  }
  return icon;
}

function drawTriangle(
  target: RgbaImage,
  pts: [[number, number], [number, number], [number, number]],
  uvs: [[number, number], [number, number], [number, number]],
  texture: RgbaImage,
  shade: number,
): void {
  const [[ax, ay], [bx, by], [cx, cy]] = pts;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(target.width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(target.height - 1, Math.ceil(Math.max(ay, by, cy)));
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (area === 0) return;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
      const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      // Java UV is 0–16 across the texture.
      const u = uvs[0][0] * w0 + uvs[1][0] * w1 + uvs[2][0] * w2;
      const v = uvs[0][1] * w0 + uvs[1][1] * w1 + uvs[2][1] * w2;
      const tx = Math.min(texture.width - 1, Math.max(0, Math.floor((u / 16) * texture.width)));
      const ty = Math.min(texture.height - 1, Math.max(0, Math.floor((v / 16) * texture.height)));
      const si = (ty * texture.width + tx) * 4;
      const alpha = texture.data[si + 3]!;
      if (alpha < 8) continue;
      const di = (y * target.width + x) * 4;
      target.data[di] = Math.round(texture.data[si]! * shade);
      target.data[di + 1] = Math.round(texture.data[si + 1]! * shade);
      target.data[di + 2] = Math.round(texture.data[si + 2]! * shade);
      target.data[di + 3] = alpha;
    }
  }
}
