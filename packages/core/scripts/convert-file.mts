// Convert a Java pack zip from the CLI (dev tool).
// Usage: npx tsx scripts/convert-file.mts <input.zip> [outdir] [oraxen-config.zip]
import fs from "node:fs";
import path from "node:path";
import { readZipDetailed } from "../src/io/zip.js";
import { convertPack, parseOraxenConfigZip } from "../src/index.js";

const [input, outdir = ".", configZipPath] = process.argv.slice(2);
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
if (configZipPath) {
  const hints = parseOraxenConfigZip(new Uint8Array(fs.readFileSync(configZipPath)));
  console.log(`oraxen hints: ${hints.items} item(s) from ${hints.files} yml file(s)`);
  baseItemHints = hints.baseItems;
  displayNameHints = hints.displayNames;
}

const packName = path.basename(input).replace(/\.(zip|mcpack)$/i, "");
const result = await convertPack(bytes, { packName, baseItemHints, displayNameHints });
fs.mkdirSync(outdir, { recursive: true });
fs.writeFileSync(path.join(outdir, packName + ".mcpack"), result.mcpack);
if (result.geyserMappings) {
  fs.writeFileSync(path.join(outdir, "geyser_mappings.json"), result.geyserMappings);
}
if (result.geyserBlockMappings) {
  fs.writeFileSync(path.join(outdir, "geyser_blocks.json"), result.geyserBlockMappings);
}
fs.writeFileSync(path.join(outdir, "report.json"), JSON.stringify(result.report, null, 2));
console.log("summary:", JSON.stringify(result.report.summary));
console.log("outputs written to", path.resolve(outdir));
