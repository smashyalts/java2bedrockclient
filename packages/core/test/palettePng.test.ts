import { describe, expect, it } from "vitest";
import { zlibSync } from "fflate";
import { decodePng } from "../src/image/png.js";

/** Minimal PNG writer for indexed-colour test fixtures. */
function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  view.setUint32(8 + payload.length, crc32(out.subarray(4, 8 + payload.length)));
  return out;
}

/** 4x2 image, 4-bit palette: indices row0 = 0,1,2,0  row1 = 2,2,1,1 */
function palettePng(): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, 4); // width
  iv.setUint32(4, 2); // height
  ihdr[8] = 4; // bit depth 4
  ihdr[9] = 3; // colour type: indexed
  // palette: [transparent-ish black, orange, brown]
  const plte = new Uint8Array([0, 0, 0, 198, 104, 21, 167, 85, 13]);
  const trns = new Uint8Array([0]); // index 0 fully transparent
  // rows bit-packed (2 px/byte), each row prefixed with filter byte 0:
  // row0: 0,1,2,0 → 0x01 0x20 ; row1: 2,2,1,1 → 0x22 0x11
  const raw = new Uint8Array([0, 0x01, 0x20, 0, 0x22, 0x11]);
  const idat = zlibSync(raw);
  return new Uint8Array([
    ...sig,
    ...chunk("IHDR", ihdr),
    ...chunk("PLTE", plte),
    ...chunk("tRNS", trns),
    ...chunk("IDAT", idat),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

describe("palette png decoding", () => {
  it("unpacks 4-bit indexed pixels with palette colours and tRNS alpha", () => {
    const img = decodePng(palettePng());
    expect(img.width).toBe(4);
    expect(img.height).toBe(2);
    const px = (x: number, y: number) => [...img.data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    expect(px(0, 0)[3]).toBe(0); // index 0 → transparent
    expect(px(1, 0)).toEqual([198, 104, 21, 255]); // orange
    expect(px(2, 0)).toEqual([167, 85, 13, 255]); // brown
    expect(px(0, 1)).toEqual([167, 85, 13, 255]);
    expect(px(3, 1)).toEqual([198, 104, 21, 255]);
  });
});
