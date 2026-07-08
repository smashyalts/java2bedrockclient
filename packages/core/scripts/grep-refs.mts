// Grep JSON files in a pack for a substring. Usage: tsx scripts/grep-refs.mts <pack.zip> <needle>
import fs from "node:fs";
import { readZipDetailed } from "../src/io/zip.js";

const [zip, needle] = process.argv.slice(2);
const { vfs } = readZipDetailed(new Uint8Array(fs.readFileSync(zip!)));
for (const p of vfs.list({ suffix: ".json" })) {
  const text = vfs.readText(p)!;
  if (text.includes(needle!)) {
    const idx = text.indexOf(needle!);
    console.log(p, "::", text.slice(Math.max(0, idx - 80), idx + 80).replace(/\s+/g, " "));
  }
}
