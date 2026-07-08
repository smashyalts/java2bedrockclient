// Reproduce icon compositing steps on one texture. Usage: tsx scripts/repro-icon.mts <texture.png> <outdir>
import fs from "node:fs";
import path from "node:path";
import { alphaBleed, blendOver, compositeLayers, createImage, decodePng, encodePng, padToSquarePow2 } from "../src/image/png.js";

const [tex, outdir] = process.argv.slice(2);
fs.mkdirSync(outdir!, { recursive: true });
const bytes = new Uint8Array(fs.readFileSync(tex!));
const img = decodePng(bytes);
console.log("decoded", img.width, "x", img.height);
// sample a few pixels
for (const [x, y] of [[16, 8], [10, 20], [20, 25]] as const) {
  const i = (y * img.width + x) * 4;
  console.log(`px(${x},${y}) =`, img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]);
}
fs.writeFileSync(path.join(outdir!, "1_decoded.png"), encodePng(img));

const img2 = decodePng(bytes);
const composited = compositeLayers([img, img2]);
fs.writeFileSync(path.join(outdir!, "2_composited.png"), encodePng(composited));

const padded = padToSquarePow2(composited);
fs.writeFileSync(path.join(outdir!, "3_padded.png"), encodePng(padded));

alphaBleed(padded);
fs.writeFileSync(path.join(outdir!, "4_bled.png"), encodePng(padded));
console.log("done");
