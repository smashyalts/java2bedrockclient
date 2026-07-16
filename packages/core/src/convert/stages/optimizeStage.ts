import type { ConversionContext, PipelineStage } from "../context.js";
import { parseLenientJson } from "../../java/json.js";
import { decodePng, encodePng, type RgbaImage } from "../../image/png.js";
import { fastHash } from "../../util/hash.js";

/**
 * Lossless pack optimizer (runs last, after every file is written):
 *
 * 1. Duplicate-texture merge: generated textures (textures/geyser_custom/**)
 *    with identical bytes collapse to one file; every JSON reference is
 *    rewritten to the surviving path. Only generated textures are merged —
 *    vanilla passthrough paths are looked up by fixed name and must stay put.
 * 2. Passthrough re-encode: textures copied verbatim from the Java pack keep
 *    whatever bloat the author's tool produced (unfiltered scanlines, text
 *    chunks). Re-encode them (filtered RGBA or indexed palette) and keep the
 *    smaller file — pixels stay bit-identical either way.
 * 3. Zopfli recompress: re-deflate every PNG's pixel stream with the zopfli
 *    wasm (exhaustive deflate; pixels bit-identical). Skipped in fast mode.
 * 4. JSON minify: every .json in the pack re-emitted without whitespace.
 *
 * Every transform is lossless for the client: same pixels, same parsed JSON.
 * Disable with optimizePack: false.
 */
/** Only zopfli PNGs at least this large — below it the byte win isn't worth the time. */
const ZOPFLI_MIN_BYTES = 4096;

/** Below this many decoded textures in a chunk, the pool round-trip isn't worth it. */
const ENCODE_POOL_MIN = 8;

export const optimizeStage: PipelineStage = {
  name: "optimize",
  async run(ctx: ConversionContext): Promise<void> {
    if (!ctx.options.optimizePack) return;

    const before = packSize(ctx);

    // --- 0. Dead-file elimination. ---
    // The textures stage copies every custom-namespace texture (textures/<ns>/…)
    // verbatim so nothing is lost, but the item/block stages then re-encode the
    // ones they use into textures/geyser_custom/…. The verbatim copies that no
    // pack JSON (item_texture, terrain_texture, attachables, flipbooks) points
    // at are pure dead weight — Bedrock never loads them and Geyser addresses
    // custom content by texture key, not path. Sweep them. Vanilla-root textures
    // (textures/blocks, /items, …) are kept: Bedrock loads those by path
    // convention, so their absence from JSON does not mean unused.
    const referenced = collectReferencedTextures(ctx);
    let swept = 0;
    for (const path of ctx.bedrock.list({ prefix: "textures/", suffix: ".png" })) {
      if (isVanillaTexturePath(path)) continue;
      if (referenced.has(stripExt(path))) continue;
      ctx.bedrock.delete(path);
      swept++;
    }
    // Also sweep unreferenced .ogg files — soundsStage copies every .ogg from
    // the pack, but only those referenced by sounds.json are actually used.
    const referencedSounds = collectReferencedSounds(ctx);
    for (const path of ctx.bedrock.list({ prefix: "sounds/", suffix: ".ogg" })) {
      if (referencedSounds.has(path)) continue;
      ctx.bedrock.delete(path);
      swept++;
    }

    // --- 1. Merge duplicate textures (all paths, not just geyser_custom). ---
    // References use the path without extension (attachables, item_texture,
    // terrain_texture, render controllers all point at "textures/..../name").
    const byHash = new Map<string, string>();
    const rewrites = new Map<string, string>();
    let merged = 0;
    for (const path of ctx.bedrock.list({ prefix: "textures/", suffix: ".png" })) {
      // Vanilla-root textures are loaded by path convention; merging them
      // would break path-based lookups even if byte-identical.
      if (isVanillaTexturePath(path)) continue;
      const bytes = ctx.bedrock.read(path)!;
      const hash = fastHash(bytes);
      const canonical = byHash.get(hash);
      if (canonical === undefined) {
        byHash.set(hash, path);
      } else {
        ctx.bedrock.delete(path);
        rewrites.set(stripExt(path), stripExt(canonical));
        merged++;
      }
    }

    // --- 2. Re-encode passthrough textures, keep the smaller encode. ---
    // Generated textures (geyser_custom) were born from encodePng and are
    // already optimal; everything else came straight from the Java pack.
    // Decode on this thread (cheap: inflate only) but encode across the worker
    // pool when injected (expensive: filter search + deflate). Chunked so at
    // most CHUNK decoded RGBA images are resident at once — unbounded decode
    // would blow browser memory on a texture-heavy pack.
    let reencoded = 0;
    const passthrough = ctx.bedrock
      .list({ suffix: ".png" })
      .filter((p) => !p.startsWith("textures/geyser_custom/"));
    const encoder = ctx.options.pngEncoder;
    const CHUNK = 64;
    for (let i = 0; i < passthrough.length; i += CHUNK) {
      const decoded: { path: string; origLen: number; image: RgbaImage }[] = [];
      for (const path of passthrough.slice(i, i + CHUNK)) {
        const bytes = ctx.bedrock.read(path)!;
        try {
          decoded.push({ path, origLen: bytes.length, image: decodePng(bytes) });
        } catch {
          // Undecodable/exotic PNG — ship the original untouched.
        }
      }
      if (decoded.length === 0) continue;
      const encoded =
        encoder !== undefined && decoded.length >= ENCODE_POOL_MIN
          ? await encoder.encode(decoded.map((d) => d.image))
          : decoded.map((d) => encodePng(d.image));
      decoded.forEach((d, j) => {
        if (encoded[j]!.length < d.origLen) {
          ctx.bedrock.write(d.path, encoded[j]!);
          reencoded++;
        }
      });
    }

    // --- 3. Rewrite references + minify all JSON. ---
    // The packaging stage minifies 3 registry files, but every other JSON
    // (attachables, animations, render_controllers, geometry, sounds, etc.)
    // is written pretty. Re-stringify all JSON without indentation.
    // When texture path rewrites are needed, apply them in the same pass.
    for (const path of ctx.bedrock.list({ suffix: ".json" })) {
      const text = ctx.bedrock.readText(path);
      if (text === undefined) continue;
      const value = parseLenientJson(text);
      if (value === undefined) continue; // never corrupt a file we can't parse
      const rewritten = rewrites.size > 0 ? rewriteStrings(value, rewrites) : value;
      ctx.bedrock.writeText(path, JSON.stringify(rewritten));
    }

    // --- 4. Opt-in zopfli recompression of larger PNGs (maxCompression). ---
    // Off by default: zopfli's single-threaded wasm is ~0.7s per file, so a
    // big pack costs minutes for ~12% off large textures (a few % of the whole
    // pack). Gated to files above a floor so the time is spent where the
    // absolute savings actually are (atlases / HD / flipbook frames).
    let zopflied = 0;
    if (ctx.options.maxCompression) {
      const candidates: { path: string; bytes: Uint8Array }[] = [];
      for (const path of ctx.bedrock.list({ suffix: ".png" })) {
        const bytes = ctx.bedrock.read(path)!;
        if (bytes.length >= ZOPFLI_MIN_BYTES) candidates.push({ path, bytes });
      }
      const apply = (i: number, smaller: Uint8Array | undefined): void => {
        if (smaller !== undefined) {
          ctx.bedrock.write(candidates[i]!.path, smaller);
          zopflied++;
        }
      };
      const pool = ctx.options.recompressor;
      if (pool !== undefined) {
        // Parallel across a worker pool (browser): dispatch every candidate,
        // the pool distributes them over N cores.
        const results = await pool.run(
          candidates.map((c) => c.bytes),
          (done, total) => ctx.progress("optimize", done, total),
        );
        results.forEach((r, i) => apply(i, r));
      } else {
        // In-process sequential fallback (node CLI/API).
        // Dynamic import so the browser build never loads @gfx/zopfli's wasm.
        const { zopfliRecompressPng } = await import("../../image/zopfliPng.js");
        let done = 0;
        for (let i = 0; i < candidates.length; i++) {
          ctx.progress("optimize", ++done, candidates.length);
          try {
            apply(i, await zopfliRecompressPng(candidates[i]!.bytes));
          } catch {
            // Zopfli failed on this file — ship what we had.
          }
        }
      }
      if (candidates.length > 0) ctx.progress("optimize", candidates.length, candidates.length);
    }

    const after = packSize(ctx);
    if (before > after) {
      const zopfliNote = !ctx.options.maxCompression
        ? "max compression off (enable it for ~12% more off large textures)"
        : zopflied === 0 && ctx.options.recompressor !== undefined
          ? "0 recompressed — this browser could not run the optimizer wasm; use the CLI/API for guaranteed max compression"
          : `${zopflied} large texture(s) recompressed`;
      ctx.report.converted("optimize", "lossless pack optimization", [
        `${swept} unreferenced texture(s) removed, ${merged} duplicate texture(s) merged, ${reencoded} texture(s) re-encoded smaller, ${zopfliNote}, JSON minified — ${formatBytes(before - after)} saved (${before} → ${after} bytes uncompressed)`,
      ]);
    }
  },
};

function stripExt(path: string): string {
  return path.replace(/\.png$/, "");
}

/**
 * Bedrock texture roots the client loads by path convention (vanilla overrides).
 * Files here are legitimately absent from every JSON, so they are never swept.
 */
const VANILLA_TEXTURE_ROOTS = [
  "textures/blocks/",
  "textures/items/",
  "textures/entity/",
  "textures/environment/",
  "textures/colormap/",
  "textures/misc/",
  "textures/models/",
  "textures/map/",
  "textures/painting/",
  "textures/particle/",
  "textures/gui/",
  "textures/ui/",
  "textures/trims/",
  "textures/flame_atlas/",
];

function isVanillaTexturePath(path: string): boolean {
  return VANILLA_TEXTURE_ROOTS.some((root) => path.startsWith(root));
}

/**
 * Every texture path (without extension) referenced by any JSON in the pack.
 * A regex sweep over the raw text catches every reference form — item_texture
 * and terrain_texture values, attachable `textures` maps, flipbook_texture
 * entries — without having to know each schema. References omit the extension;
 * we normalize both sides by stripping `.png`.
 */
function collectReferencedTextures(ctx: ConversionContext): Set<string> {
  const referenced = new Set<string>();
  const re = /textures\/[A-Za-z0-9_\-./]+/g;
  for (const path of ctx.bedrock.list({ suffix: ".json" })) {
    const text = ctx.bedrock.readText(path);
    if (text === undefined) continue;
    for (const match of text.matchAll(re)) referenced.add(stripExt(match[0]));
  }
  return referenced;
}

/** Every .ogg path referenced by sound_definitions.json (with extension). */
function collectReferencedSounds(ctx: ConversionContext): Set<string> {
  const referenced = new Set<string>();
  for (const path of ctx.bedrock.list({ suffix: ".json" })) {
    if (!path.includes("sound")) continue;
    const text = ctx.bedrock.readText(path);
    if (text === undefined) continue;
    // sound_definitions.json stores paths as "sounds/ns/path" (no .ogg extension).
    for (const match of text.matchAll(/sounds\/[A-Za-z0-9_\-./]+/g)) {
      referenced.add(match[0] + ".ogg");
    }
  }
  return referenced;
}

function packSize(ctx: ConversionContext): number {
  let total = 0;
  // Iterate the entries directly — no need to build+sort a path list just to sum lengths.
  for (const [, data] of ctx.bedrock.entries()) total += data.length;
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
