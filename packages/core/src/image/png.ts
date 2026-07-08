import { decode } from "fast-png";
import UPNG from "upng-js";

/** Always 8-bit RGBA. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array; // width * height * 4
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const img = decode(bytes);
  const { width, height, depth, channels } = img;
  const out = new Uint8Array(width * height * 4);
  const palette = img.palette as number[][] | undefined;
  // Palette alpha can come from tRNS as a separate per-index array.
  const transparency = (img as { transparency?: Uint16Array | number[] }).transparency;

  // Sub-byte depths (1/2/4-bit palette or grayscale) are bit-packed with each
  // ROW padded to a byte boundary — unpack to one index/value per pixel first.
  let src: ArrayLike<number> = img.data;
  if (depth < 8) {
    const unpacked = new Uint8Array(width * height);
    const bytesPerRow = Math.ceil((width * depth) / 8);
    const packed = img.data as Uint8Array;
    const perByte = 8 / depth;
    const mask = (1 << depth) - 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = packed[y * bytesPerRow + Math.floor(x / perByte)]!;
        const shift = 8 - depth * ((x % perByte) + 1);
        unpacked[y * width + x] = (byte >> shift) & mask;
      }
    }
    src = unpacked;
  }

  const maxVal = depth === 16 ? 65535 : (1 << Math.min(depth, 8)) - 1;
  const to8 = (v: number): number => Math.round((v / maxVal) * 255);

  for (let i = 0; i < width * height; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    if (palette !== undefined && channels === 1) {
      const idx = src[i]!;
      const entry = palette[idx] ?? [0, 0, 0];
      [r, g, b] = [entry[0]!, entry[1]!, entry[2]!];
      a = entry.length > 3 ? entry[3]! : transparency?.[idx] !== undefined ? Number(transparency[idx]) : 255;
    } else if (channels === 1) {
      r = g = b = to8(src[i]!);
    } else if (channels === 2) {
      r = g = b = to8(src[i * 2]!);
      a = to8(src[i * 2 + 1]!);
    } else if (channels === 3) {
      r = to8(src[i * 3]!);
      g = to8(src[i * 3 + 1]!);
      b = to8(src[i * 3 + 2]!);
    } else {
      r = to8(src[i * 4]!);
      g = to8(src[i * 4 + 1]!);
      b = to8(src[i * 4 + 2]!);
      a = to8(src[i * 4 + 3]!);
    }
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return { width, height, data: out };
}

export function encodePng(image: RgbaImage): Uint8Array {
  // UPNG lossless mode (cnum 0): scanline filtering + proper deflate — output
  // is a fraction of a naive unfiltered RGBA encode, pixels bit-identical.
  const buf = image.data.buffer.slice(
    image.data.byteOffset,
    image.data.byteOffset + image.data.byteLength,
  ) as ArrayBuffer;
  return new Uint8Array(UPNG.encode([buf], image.width, image.height, 0));
}

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Nearest-neighbour scale (pixel-art safe). */
export function scaleNearest(src: RgbaImage, width: number, height: number): RgbaImage {
  if (src.width === width && src.height === height) return src;
  const dst = createImage(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor((y * src.height) / height);
    for (let x = 0; x < width; x++) {
      const sx = Math.floor((x * src.width) / width);
      const si = (sy * src.width + sx) * 4;
      const di = (y * width + x) * 4;
      dst.data[di] = src.data[si]!;
      dst.data[di + 1] = src.data[si + 1]!;
      dst.data[di + 2] = src.data[si + 2]!;
      dst.data[di + 3] = src.data[si + 3]!;
    }
  }
  return dst;
}

/** Alpha-blend `top` over `base` in place (sizes must match). */
export function blendOver(base: RgbaImage, top: RgbaImage): void {
  const n = base.width * base.height * 4;
  for (let i = 0; i < n; i += 4) {
    const ta = top.data[i + 3]! / 255;
    if (ta === 0) continue;
    const ba = base.data[i + 3]! / 255;
    const outA = ta + ba * (1 - ta);
    if (outA === 0) continue;
    for (let c = 0; c < 3; c++) {
      const tc = top.data[i + c]!;
      const bc = base.data[i + c]!;
      base.data[i + c] = Math.round((tc * ta + bc * ba * (1 - ta)) / outA);
    }
    base.data[i + 3] = Math.round(outA * 255);
  }
}

/** Multiply every pixel by an RGB tint (0xRRGGBB). */
export function tint(image: RgbaImage, rgb: number): void {
  const tr = ((rgb >> 16) & 0xff) / 255;
  const tg = ((rgb >> 8) & 0xff) / 255;
  const tb = (rgb & 0xff) / 255;
  const n = image.width * image.height * 4;
  for (let i = 0; i < n; i += 4) {
    image.data[i] = Math.round(image.data[i]! * tr);
    image.data[i + 1] = Math.round(image.data[i + 1]! * tg);
    image.data[i + 2] = Math.round(image.data[i + 2]! * tb);
  }
}

/**
 * Pad an image to a square power-of-two canvas (art centred, transparent
 * padding). Bedrock's item atlas produces black mipmap artifacts on
 * non-square / non-power-of-two textures.
 */
export function padToSquarePow2(image: RgbaImage): RgbaImage {
  const target = nextPow2(Math.max(image.width, image.height));
  if (image.width === target && image.height === target) return image;
  const out = createImage(target, target);
  const dx = Math.floor((target - image.width) / 2);
  const dy = Math.floor((target - image.height) / 2);
  for (let y = 0; y < image.height; y++) {
    const srcOff = y * image.width * 4;
    const dstOff = ((dy + y) * target + dx) * 4;
    out.data.set(image.data.subarray(srcOff, srcOff + image.width * 4), dstOff);
  }
  return out;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Crop a vertical animation strip (flipbook) to its first frame.
 * Returns the image unchanged when it is not taller than wide.
 */
export function firstFrame(image: RgbaImage): RgbaImage {
  if (image.height <= image.width) return image;
  return {
    width: image.width,
    height: image.width,
    data: image.data.slice(0, image.width * image.width * 4),
  };
}

/**
 * Alpha bleed: copy the colour of the nearest opaque pixel into fully
 * transparent pixels. Prevents black fringing when the texture is rendered
 * with bilinear filtering (Bedrock UI does this for non-16px icons).
 */
export function alphaBleed(image: RgbaImage): void {
  const { width, height, data } = image;
  const queue: number[] = [];
  const visited = new Uint8Array(width * height);
  // Seed with all opaque pixels.
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3]! > 0) {
      visited[i] = 1;
      queue.push(i);
    }
  }
  if (queue.length === 0 || queue.length === width * height) return;
  // BFS outward, copying RGB from the pixel we came from.
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head]!;
    const x = idx % width;
    const y = (idx - x) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (visited[nIdx]) continue;
      visited[nIdx] = 1;
      data[nIdx * 4] = data[idx * 4]!;
      data[nIdx * 4 + 1] = data[idx * 4 + 1]!;
      data[nIdx * 4 + 2] = data[idx * 4 + 2]!;
      // alpha stays 0
      queue.push(nIdx);
    }
  }
}

/** Composite sprite layers bottom-first into one image, scaling to the largest layer. */
export function compositeLayers(layers: RgbaImage[]): RgbaImage {
  if (layers.length === 0) throw new Error("no layers to composite");
  if (layers.length === 1) return layers[0]!;
  const width = Math.max(...layers.map((l) => l.width));
  const height = Math.max(...layers.map((l) => l.height));
  const out = createImage(width, height);
  for (const layer of layers) {
    blendOver(out, scaleNearest(layer, width, height));
  }
  return out;
}
