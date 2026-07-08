// Print texture dimensions. Usage: tsx scripts/tex-sizes.mts <pack.zip> <needle...>
import fs from "node:fs";
import { readZipDetailed } from "../src/io/zip.js";
import { decodePng } from "../src/image/png.js";

const [zip, ...needles] = process.argv.slice(2);
const { vfs } = readZipDetailed(new Uint8Array(fs.readFileSync(zip!)));
for (const needle of needles) {
  for (const p of vfs.list({ suffix: ".png" }).filter((p) => p.includes(needle)).slice(0, 6)) {
    try {
      const img = decodePng(vfs.read(p)!);
      console.log(p, img.width + "x" + img.height);
    } catch (e) {
      console.log(p, "DECODE FAIL", (e as Error).message);
    }
  }
}
