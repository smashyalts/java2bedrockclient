// Convert a Java pack zip from the CLI (dev tool).
// Usage: npx tsx scripts/convert-file.mts <input.zip> [outdir] [config1.zip config2.zip ...]
import fs from "node:fs";
import path from "node:path";
import { readZipDetailed } from "../src/io/zip.js";
import { convertPack, parseOraxenConfigZips } from "../src/index.js";

const [input, outdir = ".", ...configZipPaths] = process.argv.slice(2);
if (!input) {
  console.error("usage: tsx scripts/convert-file.mts <input.zip> [outdir]");
  process.exit(1);
}

const bytes = new Uint8Array(fs.readFileSync(input));

// Diagnostics first.
const { vfs, failed } = readZipDetailed(bytes);
console.log("readable entries:", vfs.size, "| unreadable:", failed.length);
if (failed.length > 0) console.log("unreadable sample:", failed.slice(0, 3));
console.log("has pack.mcmeta at root:", vfs.has("pack.mcmeta"));
const namespaces = [...new Set(vfs.list({ prefix: "assets/" }).map((p) => p.split("/")[1]))];
console.log("namespaces:", namespaces.join(", "));

let baseItemHints: Record<string, string> | undefined;
let displayNameHints: Record<string, string> | undefined;
let equippableHints: Record<string, { asset: string; slot: string }> | undefined;
let cmdItemKeys: Record<string, string> | undefined;
let backpackItems: string[] | undefined;
let furnitureItems: string[] | undefined;
if (configZipPaths.length > 0) {
  const hints = parseOraxenConfigZips(configZipPaths.map((p) => new Uint8Array(fs.readFileSync(p))));
  console.log(`oraxen hints: ${hints.items} item(s) from ${hints.files} yml file(s), ${Object.keys(hints.equippables).length} equippable(s)`);
  baseItemHints = hints.baseItems;
  displayNameHints = hints.displayNames;
  equippableHints = hints.equippables;
  cmdItemKeys = hints.cmdKeys;
  backpackItems = hints.backpacks;
  furnitureItems = hints.furniture;
  if (hints.backpacks.length > 0) console.log(`backpack cosmetics: ${hints.backpacks.join(", ")}`);
  if (hints.furniture.length > 0) console.log(`furniture items: ${hints.furniture.length}`);
}

const packName = path.basename(input).replace(/\.(zip|mcpack)$/i, "");
const result = await convertPack(bytes, { packName, baseItemHints, displayNameHints, equippableHints, cmdItemKeys, backpackItems, furnitureItems });
fs.mkdirSync(outdir, { recursive: true });
fs.writeFileSync(path.join(outdir, packName + ".mcpack"), result.mcpack);
if (result.geyserMappings) {
  fs.writeFileSync(path.join(outdir, "geyser_mappings.json"), result.geyserMappings);
}
if (result.geyserBlockMappings) {
  fs.writeFileSync(path.join(outdir, "geyser_blocks.json"), result.geyserBlockMappings);
}
if (result.displayEntityMappings) {
  fs.writeFileSync(path.join(outdir, "geyser_displayentity_mappings.yml"), result.displayEntityMappings);
}
fs.writeFileSync(path.join(outdir, "report.json"), JSON.stringify(result.report, null, 2));
console.log("summary:", JSON.stringify(result.report.summary));
console.log("outputs written to", path.resolve(outdir));
