// Validate a generated .mcpack. Usage: tsx scripts/validate-mcpack.mts <file.mcpack>
import fs from "node:fs";
import { readZipDetailed } from "../src/io/zip.js";

const { vfs } = readZipDetailed(new Uint8Array(fs.readFileSync(process.argv[2]!)));
const paths = vfs.list();
console.log("total files:", paths.length);

const top: Record<string, number> = {};
for (const p of paths) {
  const t = p.split("/")[0]!;
  top[t] = (top[t] ?? 0) + 1;
}
console.log("top-level:", JSON.stringify(top));
console.log("manifest:", vfs.readText("manifest.json")?.slice(0, 260));

let bad = 0;
for (const p of paths.filter((p) => p.endsWith(".json"))) {
  try {
    JSON.parse(vfs.readText(p)!);
  } catch (e) {
    bad++;
    if (bad < 4) console.log("BAD JSON:", p, (e as Error).message);
  }
}
console.log("unparseable json files:", bad);

const itText = vfs.readText("textures/item_texture.json");
if (itText !== undefined) {
  const it = JSON.parse(itText);
  const keys = Object.keys(it.texture_data);
  console.log("item_texture entries:", keys.length);
  let missing = 0;
  for (const k of keys) {
    const t = it.texture_data[k].textures + ".png";
    if (!vfs.has(t)) {
      missing++;
      if (missing < 4) console.log("missing icon:", t);
    }
  }
  console.log("missing icon textures:", missing);
}
console.log(
  "attachables:",
  paths.filter((p) => p.startsWith("attachables/")).length,
  "| geometries:",
  paths.filter((p) => p.endsWith(".geo.json")).length,
  "| animations:",
  paths.filter((p) => p.startsWith("animations/")).length,
);
