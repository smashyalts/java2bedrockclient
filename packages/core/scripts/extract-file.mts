// Extract one file from a zip. Usage: tsx scripts/extract-file.mts <zip> <path-substring> <out>
import fs from "node:fs";
import { readZipDetailed } from "../src/io/zip.js";

const [zip, needle, out] = process.argv.slice(2);
const { vfs } = readZipDetailed(new Uint8Array(fs.readFileSync(zip!)));
const match = vfs.list().find((p) => p.includes(needle!));
if (!match) {
  console.log("no match for", needle);
  process.exit(1);
}
fs.writeFileSync(out!, vfs.read(match)!);
console.log("extracted", match, "->", out);
