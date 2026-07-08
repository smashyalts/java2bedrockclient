// Extract multiple files by substrings. Usage: tsx scripts/extract-many.mts <zip> <outdir> <needle1> <needle2> ...
import fs from "node:fs";
import path from "node:path";
import { readZipDetailed } from "../src/io/zip.js";

const [zip, outdir, ...needles] = process.argv.slice(2);
const { vfs } = readZipDetailed(new Uint8Array(fs.readFileSync(zip!)));
fs.mkdirSync(outdir!, { recursive: true });
for (const needle of needles) {
  const matches = vfs.list().filter((p) => p.includes(needle));
  for (const m of matches.slice(0, 3)) {
    const name = m.replace(/[\/\\]/g, "_");
    fs.writeFileSync(path.join(outdir!, name), vfs.read(m)!);
    console.log("extracted", m);
  }
  if (matches.length === 0) console.log("NO MATCH:", needle);
}
