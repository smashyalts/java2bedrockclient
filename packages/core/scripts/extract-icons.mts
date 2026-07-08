// Extract a few generated icons from an mcpack for visual inspection.
// Usage: tsx scripts/extract-icons.mts <file.mcpack> <outdir> [count]
import fs from "node:fs";
import path from "node:path";
import { readZipDetailed } from "../src/io/zip.js";

const [mcpack, outdir, countStr = "8"] = process.argv.slice(2);
const { vfs } = readZipDetailed(new Uint8Array(fs.readFileSync(mcpack!)));
fs.mkdirSync(outdir!, { recursive: true });
const icons = vfs.list({ prefix: "textures/geyser_custom/icons/", suffix: ".png" }).slice(0, Number(countStr));
for (const p of icons) {
  const name = path.basename(p);
  fs.writeFileSync(path.join(outdir!, name), vfs.read(p)!);
  console.log("extracted", name);
}
