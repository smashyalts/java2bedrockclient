// Render a model with different rotation conventions to find the right one.
// Usage: tsx scripts/render-variants.mts <pack.zip> <model-substring> <outdir>
import fs from "node:fs";
import path from "node:path";
import { readZipDetailed } from "../src/io/zip.js";
import { JavaPack } from "../src/java/javaPack.js";
import { resolveModel } from "../src/resolve/modelResolver.js";
import { decodePng, encodePng, createImage, type RgbaImage } from "../src/image/png.js";
import { defaultUv } from "../src/bedrock/geometry.js";
import type { JavaElement, JavaFaceName } from "../src/java/model.js";

const [packPath, needle, outdir] = process.argv.slice(2);
const { vfs } = readZipDetailed(new Uint8Array(fs.readFileSync(packPath!)));
const pack = JavaPack.open(vfs);

const modelAsset = pack.list({ suffix: ".json" }).find((p) => p.includes("models/") && p.includes(needle!))!;
const id = modelAsset.replace(/^assets\/([^/]+)\/models\/(.+)\.json$/, "$1:$2");
console.log("model:", id);
const resolved = resolveModel(pack, id)!;
const gui = resolved.display["gui"];
console.log("gui:", JSON.stringify(gui));

const images = new Map<string, RgbaImage>();
function texImage(ref: string): RgbaImage | undefined {
  let value = ref;
  while (value.startsWith("#")) value = resolved.textures[value.slice(1)] ?? "";
  if (!value) return undefined;
  if (!images.has(value)) {
    const bytes = pack.read(pack.assetPath("textures", value, ".png"));
    if (!bytes) return undefined;
    images.set(value, decodePng(bytes));
  }
  return images.get(value);
}

type Vec3 = [number, number, number];
function rot(v: Vec3, axis: "x" | "y" | "z", deg: number, o: Vec3): Vec3 {
  const r = (deg * Math.PI) / 180, s = Math.sin(r), c = Math.cos(r);
  const [x, y, z] = [v[0] - o[0], v[1] - o[1], v[2] - o[2]];
  let out: Vec3;
  if (axis === "x") out = [x, y * c - z * s, y * s + z * c];
  else if (axis === "y") out = [x * c + z * s, y, -x * s + z * c];
  else out = [x * c - y * s, x * s + y * c, z];
  return [out[0] + o[0], out[1] + o[1], out[2] + o[2]];
}

function faceCorners(face: JavaFaceName, from: Vec3, to: Vec3): [Vec3, Vec3, Vec3, Vec3] {
  const [x1, y1, z1] = from, [x2, y2, z2] = to;
  switch (face) {
    case "north": return [[x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1]];
    case "south": return [[x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2]];
    case "west": return [[x1, y2, z1], [x1, y2, z2], [x1, y1, z2], [x1, y1, z1]];
    case "east": return [[x2, y2, z2], [x2, y2, z1], [x2, y1, z1], [x2, y1, z2]];
    case "up": return [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]];
    case "down": return [[x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1]];
  }
}

const SHADE: Record<JavaFaceName, number> = { up: 1, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 };

function render(order: ("x" | "y" | "z")[], signs: Vec3, flipZ: boolean, size = 96): RgbaImage {
  const r: Vec3 = gui?.rotation ?? [30, 225, 0];
  const center: Vec3 = [8, 8, 8];
  interface F { pts: [number, number][]; depth: number; uv: [number, number, number, number]; img: RgbaImage; shade: number }
  const faces: F[] = [];
  for (const el of resolved.elements ?? []) {
    for (const fn of Object.keys(el.faces ?? {}) as JavaFaceName[]) {
      const face = el.faces![fn]!;
      const img = texImage(face.texture);
      if (!img) continue;
      let corners = faceCorners(fn, el.from, el.to);
      if (el.rotation) corners = corners.map((p) => rot(p, el.rotation!.axis, el.rotation!.angle, el.rotation!.origin)) as typeof corners;
      const viewed = corners.map((p) => {
        let v = p;
        const angles: Record<string, number> = { x: r[0] * signs[0], y: r[1] * signs[1], z: r[2] * signs[2] };
        for (const ax of order) v = rot(v, ax, angles[ax]!, center);
        return v;
      });
      const depth = viewed.reduce((a, v) => a + (flipZ ? -v[2] : v[2]), 0) / 4;
      faces.push({
        pts: viewed.map((v) => [v[0], v[1]] as [number, number]),
        depth,
        uv: face.uv ?? defaultUv(fn, el.from, el.to),
        img,
        shade: SHADE[fn],
      });
    }
  }
  const icon = createImage(size, size);
  if (faces.length === 0) return icon;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of faces) for (const [x, y] of f.pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const sc = (size * 0.92) / span;
  const ox = (size - (maxX - minX) * sc) / 2, oy = (size - (maxY - minY) * sc) / 2;
  const toS = ([x, y]: [number, number]): [number, number] => [(x - minX) * sc + ox, size - ((y - minY) * sc + oy)];
  faces.sort((a, b) => a.depth - b.depth);
  for (const f of faces) {
    const p = f.pts.map(toS);
    const [u1, v1, u2, v2] = f.uv;
    const uvs: [number, number][] = [[u1, v1], [u2, v1], [u2, v2], [u1, v2]];
    tri(icon, [p[0]!, p[1]!, p[2]!], [uvs[0]!, uvs[1]!, uvs[2]!], f.img, f.shade);
    tri(icon, [p[0]!, p[2]!, p[3]!], [uvs[0]!, uvs[2]!, uvs[3]!], f.img, f.shade);
  }
  return icon;
}

function tri(t: RgbaImage, pts: [number, number][], uvs: [number, number][], tex: RgbaImage, shade: number) {
  const [[ax, ay], [bx, by], [cx, cy]] = pts as [[number, number], [number, number], [number, number]];
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (area === 0) return;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(t.width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(t.height - 1, Math.ceil(Math.max(ay, by, cy)));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
    const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
    const w2 = 1 - w0 - w1;
    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
    const u = uvs[0]![0] * w0 + uvs[1]![0] * w1 + uvs[2]![0] * w2;
    const v = uvs[0]![1] * w0 + uvs[1]![1] * w1 + uvs[2]![1] * w2;
    const tx = Math.min(tex.width - 1, Math.max(0, Math.floor((u / 16) * tex.width)));
    const ty = Math.min(tex.height - 1, Math.max(0, Math.floor((v / 16) * tex.height)));
    const si = (ty * tex.width + tx) * 4;
    const a = tex.data[si + 3]!;
    if (a < 8) continue;
    const di = (y * t.width + x) * 4;
    t.data[di] = Math.round(tex.data[si]! * shade);
    t.data[di + 1] = Math.round(tex.data[si + 1]! * shade);
    t.data[di + 2] = Math.round(tex.data[si + 2]! * shade);
    t.data[di + 3] = a;
  }
}

fs.mkdirSync(outdir!, { recursive: true });
const combos: [string, ("x" | "y" | "z")[], Vec3, boolean][] = [
  ["xyz_pos_far", ["x", "y", "z"], [1, 1, 1], false],
  ["xyz_pos_near", ["x", "y", "z"], [1, 1, 1], true],
  ["zyx_pos_far", ["z", "y", "x"], [1, 1, 1], false],
  ["zyx_pos_near", ["z", "y", "x"], [1, 1, 1], true],
  ["xyz_negy_far", ["x", "y", "z"], [1, -1, 1], false],
  ["zyx_negxy_near", ["z", "y", "x"], [-1, -1, 1], true],
  ["current", ["y", "x", "z"], [1, -1, 1], false],
];
for (const [label, order, signs, flip] of combos) {
  fs.writeFileSync(path.join(outdir!, label + ".png"), encodePng(render(order, signs, flip)));
}
console.log("wrote", combos.length, "variants to", outdir);
