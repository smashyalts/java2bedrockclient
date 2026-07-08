// Inspect a model + its textures from a java pack. Usage: tsx scripts/debug-model.mts <pack.zip> <substring>
import fs from "node:fs";
import { readZipDetailed } from "../src/io/zip.js";

const [pack, needle] = process.argv.slice(2);
const { vfs } = readZipDetailed(new Uint8Array(fs.readFileSync(pack!)));
const models = vfs.list({ suffix: ".json" }).filter((p) => p.includes("models/") && p.includes(needle!));
console.log("models matching:", models.slice(0, 5));
const m = models[0];
if (m) {
  const json = JSON.parse(vfs.readText(m)!);
  console.log("display keys:", Object.keys(json.display ?? {}));
  console.log("gui display:", JSON.stringify(json.display?.gui));
  console.log("textures:", JSON.stringify(json.textures));
  console.log("elements:", (json.elements ?? []).length);
  const el = json.elements?.[0];
  if (el) console.log("element0:", JSON.stringify(el).slice(0, 400));
}
