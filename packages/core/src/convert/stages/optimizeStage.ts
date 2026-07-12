import type { ConversionContext, PipelineStage } from "../context.js";
import { parseLenientJson } from "../../java/json.js";
import { sha256 } from "@noble/hashes/sha2";

/**
 * Lossless pack optimizer (runs last, after every file is written):
 *
 * 1. Duplicate-texture merge: generated textures (textures/geyser_custom/**)
 *    with identical bytes collapse to one file; every JSON reference is
 *    rewritten to the surviving path. Only generated textures are merged —
 *    vanilla passthrough paths are looked up by fixed name and must stay put.
 * 2. JSON minify: every .json in the pack re-emitted without whitespace.
 *
 * Both transforms are byte-lossless for the client: same pixels, same parsed
 * JSON. Disable with optimizePack: false.
 */
export const optimizeStage: PipelineStage = {
  name: "optimize",
  run(ctx: ConversionContext): void {
    if (!ctx.options.optimizePack) return;

    const before = packSize(ctx);

    // --- 1. Merge duplicate generated textures. ---
    // References use the path without extension (attachables, item_texture,
    // terrain_texture, render controllers all point at "textures/..../name").
    const byHash = new Map<string, string>();
    const rewrites = new Map<string, string>();
    let merged = 0;
    for (const path of ctx.bedrock.list({ prefix: "textures/geyser_custom/", suffix: ".png" })) {
      const bytes = ctx.bedrock.read(path)!;
      const hash = hex(sha256(bytes));
      const canonical = byHash.get(hash);
      if (canonical === undefined) {
        byHash.set(hash, path);
      } else {
        ctx.bedrock.delete(path);
        rewrites.set(stripExt(path), stripExt(canonical));
        merged++;
      }
    }

    // --- 2. Rewrite references + minify all JSON. ---
    for (const path of ctx.bedrock.list({ suffix: ".json" })) {
      const text = ctx.bedrock.readText(path);
      if (text === undefined) continue;
      let value: unknown;
      try {
        value = parseLenientJson(text);
      } catch {
        continue; // never corrupt a file we can't parse
      }
      if (rewrites.size > 0) value = rewriteStrings(value, rewrites);
      ctx.bedrock.writeText(path, JSON.stringify(value));
    }

    const after = packSize(ctx);
    if (before > after) {
      ctx.report.converted("optimize", "lossless pack optimization", [
        `${merged} duplicate texture(s) merged, JSON minified — ${formatBytes(before - after)} saved (${before} → ${after} bytes uncompressed)`,
      ]);
    }
  },
};

function stripExt(path: string): string {
  return path.replace(/\.png$/, "");
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function packSize(ctx: ConversionContext): number {
  let total = 0;
  for (const path of ctx.bedrock.list()) total += ctx.bedrock.read(path)!.length;
  return total;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Recursively replace string values that exactly match a rewritten texture path. */
function rewriteStrings(value: unknown, rewrites: Map<string, string>): unknown {
  if (typeof value === "string") {
    return rewrites.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteStrings(v, rewrites));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteStrings(v, rewrites);
    }
    return out;
  }
  return value;
}
