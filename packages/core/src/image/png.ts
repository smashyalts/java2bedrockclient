import { decode } from "fast-png";
import UPNG from "upng-js";
import { zlibSync } from "fflate";
import { timeOp } from "../report/timings.js";

/** Always 8-bit RGBA. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array; // width * height * 4
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  return timeOp("png.decode", () => decodePngUntimed(bytes));
}

function decodePngUntimed(bytes: Uint8Array): RgbaImage {
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
  // Pixel art almost always fits a ≤256-colour palette, where an indexed PNG
  // is both smaller and far cheaper than UPNG's filter search. Try it first
  // and, when it fits, ship it — skipping the expensive RGBA encode entirely.
  // Only images with >256 colours (photographic textures) fall back to UPNG.
  const indexed = timeOp("png.encode.indexed", () => encodeIndexedPng(image));
  if (indexed !== undefined) return indexed;
  return timeOp("png.encode.rgba", () => {
    const buf = image.data.buffer.slice(
      image.data.byteOffset,
      image.data.byteOffset + image.data.byteLength,
    ) as ArrayBuffer;
    return new Uint8Array(UPNG.encode([buf], image.width, image.height, 0));
  });
}

/* ---------- Indexed (palette) PNG encoder — lossless when ≤256 colours ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encode as colour-type-3 (indexed) PNG at the smallest bit depth that fits.
 * Palette entries with transparency sort first so tRNS truncates. Returns
 * undefined when the image has more than 256 distinct colours.
 */
export function encodeIndexedPng(image: RgbaImage): Uint8Array | undefined {
  const { width, height, data } = image;
  const seen = new Set<number>();
  for (let i = 0; i < data.length; i += 4) {
    seen.add(((data[i]! << 24) | (data[i + 1]! << 16) | (data[i + 2]! << 8) | data[i + 3]!) >>> 0);
    if (seen.size > 256) return undefined;
  }
  // Transparent entries first → shortest possible tRNS chunk.
  const palette = [...seen].sort((a, b) => (a & 0xff) - (b & 0xff));
  const indexOf = new Map<number, number>();
  palette.forEach((c, i) => indexOf.set(c, i));

  const count = palette.length;
  const depth = count <= 2 ? 1 : count <= 4 ? 2 : count <= 16 ? 4 : 8;
  const rowBytes = Math.ceil((width * depth) / 8);
  // Filter 0 per scanline; palette indices carry no gradient for filters to exploit.
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1);
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const key = ((data[p]! << 24) | (data[p + 1]! << 16) | (data[p + 2]! << 8) | data[p + 3]!) >>> 0;
      const bitPos = x * depth;
      raw[rowStart + 1 + (bitPos >> 3)]! |= indexOf.get(key)! << (8 - depth - (bitPos & 7));
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = 3; // indexed colour

  const plte = new Uint8Array(count * 3);
  palette.forEach((c, i) => {
    plte[i * 3] = c >>> 24;
    plte[i * 3 + 1] = (c >>> 16) & 0xff;
    plte[i * 3 + 2] = (c >>> 8) & 0xff;
  });

  let trnsLen = 0;
  palette.forEach((c, i) => {
    if ((c & 0xff) !== 255) trnsLen = i + 1;
  });
  const trns = new Uint8Array(trnsLen);
  for (let i = 0; i < trnsLen; i++) trns[i] = palette[i]! & 0xff;

  const chunks = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", plte),
    ...(trnsLen > 0 ? [pngChunk("tRNS", trns)] : []),
    pngChunk("IDAT", zlibSync(raw, { level: 9 })),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
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

/** Copy a rectangular region out of an image. */
export function crop(image: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const out = createImage(w, h);
  for (let row = 0; row < h; row++) {
    const srcY = y + row;
    if (srcY < 0 || srcY >= image.height) continue;
    for (let col = 0; col < w; col++) {
      const srcX = x + col;
      if (srcX < 0 || srcX >= image.width) continue;
      const si = (srcY * image.width + srcX) * 4;
      const di = (row * w + col) * 4;
      out.data.set(image.data.subarray(si, si + 4), di);
    }
  }
  return out;
}

/** Rotate an image 180°. */
export function rotate180(image: RgbaImage): RgbaImage {
  const out = createImage(image.width, image.height);
  const n = image.width * image.height;
  for (let i = 0; i < n; i++) {
    out.data.set(image.data.subarray(i * 4, i * 4 + 4), (n - 1 - i) * 4);
  }
  return out;
}

/** Flip an image vertically (top ↔ bottom). */
export function flipVertical(image: RgbaImage): RgbaImage {
  const out = createImage(image.width, image.height);
  const rowBytes = image.width * 4;
  for (let y = 0; y < image.height; y++) {
    out.data.set(
      image.data.subarray(y * rowBytes, (y + 1) * rowBytes),
      (image.height - 1 - y) * rowBytes,
    );
  }
  return out;
}

/** Paste src into dst at (x, y), overwriting pixels (no blending). */
export function blit(dst: RgbaImage, src: RgbaImage, x: number, y: number): void {
  for (let row = 0; row < src.height; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dst.height) continue;
    for (let col = 0; col < src.width; col++) {
      const dx = x + col;
      if (dx < 0 || dx >= dst.width) continue;
      dst.data.set(src.data.subarray((row * src.width + col) * 4, (row * src.width + col) * 4 + 4), (dy * dst.width + dx) * 4);
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
