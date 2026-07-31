import { readFileSync, writeFileSync } from "node:fs";
import {
  convertPack,
  parseOraxenConfigZips,
  type ConvertOptions,
  type ReportEntry,
} from "@geyser-converter/core";

// Usage: tsx test-convert.ts <pack.zip> [configZip.zip ...]
const [packPath = "packitriedtoconvert.zip", ...configPaths] = process.argv.slice(2);
const resolvedConfigPaths = configPaths.length > 0 ? configPaths : ["items 2.zip"];

async function main(): Promise<void> {
  const pack = new Uint8Array(readFileSync(packPath));
  const hints = parseOraxenConfigZips(resolvedConfigPaths.map((p) => new Uint8Array(readFileSync(p))));

  const baseOpts: Partial<ConvertOptions> = {
    packName: "testpack",
    baseItemHints: hints.baseItems,
    displayNameHints: hints.displayNames,
    equippableHints: hints.equippables,
    cmdItemKeys: hints.cmdKeys,
    colorHints: hints.colors,
    backpackItems: hints.backpacks,
    furnitureItems: hints.furniture,
    furnitureTransforms: hints.furnitureTransforms,
    configZipProvided: true,
    optimizePack: true,
  };

  const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(2) + " MB";
  const optimizeLine = (entries: ReportEntry[]): string | undefined =>
    entries.find((e) => e.stage === "optimize")?.outputs?.[0];

  console.log("=== Run 1: optimize=true, maxCompression=false ===");
  const t1 = Date.now();
  const r1 = await convertPack(pack, { ...baseOpts, maxCompression: false });
  const e1 = Date.now() - t1;
  writeFileSync("testpack_nomaxcomp.mcpack", r1.mcpack);
  writeFileSync("report_nomaxcomp.json", JSON.stringify(r1.report, null, 2));
  console.log("Time:", e1, "ms");
  console.log("Summary:", JSON.stringify(r1.report.summary));
  console.log("mcpack size:", r1.mcpack.length, "bytes (" + mb(r1.mcpack.length) + ")");
  console.log("Optimize:", optimizeLine(r1.report.entries) ?? "(none)");

  console.log("\n=== Run 2: optimize=true, maxCompression=true ===");
  const t2 = Date.now();
  const r2 = await convertPack(pack, { ...baseOpts, maxCompression: true });
  const e2 = Date.now() - t2;
  writeFileSync("testpack_maxcomp.mcpack", r2.mcpack);
  writeFileSync("report_maxcomp.json", JSON.stringify(r2.report, null, 2));
  console.log("Time:", e2, "ms");
  console.log("mcpack size:", r2.mcpack.length, "bytes (" + mb(r2.mcpack.length) + ")");
  console.log("Optimize:", optimizeLine(r2.report.entries) ?? "(none)");

  console.log("\n=== Comparison ===");
  console.log("No maxcomp:", mb(r1.mcpack.length), "| Maxcomp:", mb(r2.mcpack.length));
  console.log("Saved:", ((1 - r2.mcpack.length / r1.mcpack.length) * 100).toFixed(1) + "%", "| Time diff:", e2 - e1, "ms");

  const byStatus = (status: ReportEntry["status"]): ReportEntry[] =>
    r1.report.entries.filter((e) => e.status === status);
  const dump = (label: string, entries: ReportEntry[]): void => {
    if (entries.length === 0) return;
    console.log(`\n=== ${label} (${entries.length} total, first 30) ===`);
    for (const e of entries.slice(0, 30)) console.log(e.stage, "|", e.source, "|", e.detail);
    if (entries.length > 30) console.log("... and", entries.length - 30, "more");
  };
  dump("Errors", byStatus("error"));
  dump("Skipped", byStatus("skipped"));
  dump("Approximated", byStatus("approximated"));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
