// Find models with display.head transforms. Usage: tsx scripts/find-display.mts <pack.zip> <ns-substring>
import fs from "node:fs";
import { readZipDetailed } from "../src/io/zip.js";

const [zip, needle] = process.argv.slice(2);
const { vfs } = readZipDetailed(new Uint8Array(fs.readFileSync(zip!)));
for (const p of vfs.list({ suffix: ".json" })) {
  if (!p.includes("models/") || !p.includes(needle!)) continue;
  const text = vfs.readText(p)!;
  if (!text.includes('"display"')) continue;
  const json = JSON.parse(text);
  if (json.display?.head === undefined) continue;
  console.log("==", p);
  console.log("  head:", JSON.stringify(json.display.head));
  console.log("  elements:", (json.elements ?? []).length, "| groups/other display keys:", Object.keys(json.display).join(","));
  const el = json.elements?.[0];
  if (el) console.log("  element0 from/to:", JSON.stringify(el.from), JSON.stringify(el.to), "rot:", JSON.stringify(el.rotation));
}
