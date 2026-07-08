// Dump font providers + their texture sizes. Usage: tsx scripts/dump-fonts.mts <pack.zip>
import fs from "node:fs";
import { readZipDetailed } from "../src/io/zip.js";
import { JavaPack, parseResourceLocation } from "../src/java/javaPack.js";
import { decodePng } from "../src/image/png.js";

const { vfs } = readZipDetailed(new Uint8Array(fs.readFileSync(process.argv[2]!)));
const pack = JavaPack.open(vfs);

for (const ns of pack.namespaces()) {
  for (const path of pack.list({ prefix: `assets/${ns}/font/`, suffix: ".json" })) {
    const asset = pack.readJson<{ providers?: any[] }>(path);
    console.log("== " + path + " (" + (asset?.providers?.length ?? 0) + " providers)");
    for (const p of asset?.providers ?? []) {
      if (p.type === "bitmap") {
        const loc = parseResourceLocation(String(p.file).replace(/\.png$/, ""));
        const texPath = `assets/${loc.namespace}/textures/${loc.path}.png`;
        const bytes = pack.read(texPath);
        let dims = "MISSING";
        if (bytes) {
          const img = decodePng(bytes);
          dims = img.width + "x" + img.height;
        }
        const chars = (p.chars ?? []).map((c: string) =>
          [...c].map((ch) => "U+" + ch.codePointAt(0)!.toString(16).toUpperCase()).join(","),
        );
        console.log(`  bitmap ${p.file} tex=${dims} height=${p.height ?? 8} ascent=${p.ascent ?? 7} rows=${(p.chars ?? []).length} rowLen=${[...(p.chars?.[0] ?? "")].length} chars=[${chars.slice(0, 2).join(" | ")}${chars.length > 2 ? " ..." : ""}]`);
      } else {
        console.log(`  ${p.type} ${JSON.stringify(p).slice(0, 140)}`);
      }
    }
  }
}
