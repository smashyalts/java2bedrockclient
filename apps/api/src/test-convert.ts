import { readFileSync, writeFileSync } from "node:fs";
import { convertPack, parseOraxenConfigZips } from "@geyser-converter/core";

async function main() {
  const pack = new Uint8Array(readFileSync("packitriedtoconvert.zip"));
  const config = new Uint8Array(readFileSync("items 2.zip"));
  const hints = parseOraxenConfigZips([config]);

  const baseOpts: any = {
    packName: "testpack",
    baseItemHints: hints.baseItems,
    displayNameHints: hints.displayNames,
    equippableHints: hints.equippables,
    cmdItemKeys: hints.cmdKeys,
    colorHints: hints.colors,
    backpackItems: hints.backpacks,
    furnitureItems: hints.furniture,
    configZipProvided: true,
    optimizePack: true,
  };

  // Run 1: no max compression
  console.log("=== Run 1: optimize=true, maxCompression=false ===");
  const t1 = Date.now();
  const r1 = await convertPack(pack, { ...baseOpts, maxCompression: false });
  const e1 = Date.now() - t1;
  writeFileSync("testpack_nomaxcomp.mcpack", r1.mcpack);
  writeFileSync("report_nomaxcomp.json", JSON.stringify(r1.report, null, 2));
  console.log("Time:", e1, "ms");
  console.log("Summary:", JSON.stringify(r1.report.summary));
  console.log("mcpack size:", r1.mcpack.length, "bytes (" + (r1.mcpack.length / 1024 / 1024).toFixed(2) + " MB)");
  const opt1 = r1.report.entries.find((e: any) => e.stage === "optimize");
  if (opt1) console.log("Optimize:", opt1.outputs?.[0]);
  console.log("timings:", JSON.stringify(r1.timings.stages.filter((s: any) => s.ms > 0).sort((a: any, b: any) => b.ms - a.ms)));

  // Run 2: with max compression
  console.log("\n=== Run 2: optimize=true, maxCompression=true ===");
  const t2 = Date.now();
  const r2 = await convertPack(pack, { ...baseOpts, maxCompression: true });
  const e2 = Date.now() - t2;
  writeFileSync("testpack_maxcomp.mcpack", r2.mcpack);
  writeFileSync("report_maxcomp.json", JSON.stringify(r2.report, null, 2));
  console.log("Time:", e2, "ms");
  console.log("Summary:", JSON.stringify(r2.report.summary));
  console.log("mcpack size:", r2.mcpack.length, "bytes (" + (r2.mcpack.length / 1024 / 1024).toFixed(2) + " MB)");
  const opt2 = r2.report.entries.find((e: any) => e.stage === "optimize");
  if (opt2) console.log("Optimize:", opt2.outputs?.[0]);
  console.log("timings:", JSON.stringify(r2.timings.stages.filter((s: any) => s.ms > 0).sort((a: any, b: any) => b.ms - a.ms)));

  console.log("\n=== Comparison ===");
  console.log("No maxcomp:", r1.mcpack.length, "bytes (" + (r1.mcpack.length / 1024 / 1024).toFixed(2) + " MB)");
  console.log("Maxcomp:   ", r2.mcpack.length, "bytes (" + (r2.mcpack.length / 1024 / 1024).toFixed(2) + " MB)");
  console.log("Saved:     ", r1.mcpack.length - r2.mcpack.length, "bytes (" + ((1 - r2.mcpack.length / r1.mcpack.length) * 100).toFixed(1) + "%)");
  console.log("Time diff: ", e2 - e1, "ms");

  // Errors and skips
  const errors = r1.report.entries.filter((e: any) => e.status === "error");
  if (errors.length > 0) { console.log("\n=== Errors ==="); for (const e of errors) console.log(e.stage, e.source, e.detail); }
  const skips = r1.report.entries.filter((e: any) => e.status === "skipped");
  if (skips.length > 0) {
    console.log("\n=== Skipped (" + skips.length + " total, first 30) ===");
    for (const e of skips.slice(0, 30)) console.log(e.stage, "|", e.source, "|", e.detail);
    if (skips.length > 30) console.log("... and", skips.length - 30, "more");
  }
  const approx = r1.report.entries.filter((e: any) => e.status === "approximated");
  if (approx.length > 0) {
    console.log("\n=== Approximated (" + approx.length + " total, first 30) ===");
    for (const e of approx.slice(0, 30)) console.log(e.stage, "|", e.source, "|", e.detail);
    if (approx.length > 30) console.log("... and", approx.length - 30, "more");
  }
  // Bow-pull entries
  const bow = r1.report.entries.filter((e: any) => e.stage === "bow-pull");
  if (bow.length > 0) { console.log("\n=== Bow-pull ==="); for (const e of bow) console.log(e.status, e.source, e.detail ?? e.outputs?.join("; ")); }
  else console.log("\n=== Bow-pull: none ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
