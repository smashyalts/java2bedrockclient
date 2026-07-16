import type { ConversionContext, PipelineStage } from "../context.js";
import { remapVanillaTexture } from "../../data/vanillaTextureMap.js";

/**
 * Real vanilla texture categories. Anything else directly under
 * assets/minecraft/textures/ is a pack dumping CUSTOM content into the minecraft
 * namespace (armour sets, glyph sheets, emotes) — those are owned by the item /
 * armour / font stages, not a "skipped vanilla" category.
 */
const VANILLA_TEXTURE_CATEGORIES = new Set([
  "block", "item", "entity", "environment", "colormap", "misc", "models", "map",
  "gui", "particle", "painting", "font", "mob_effect", "trims", "effect",
]);
/** Vanilla categories a dedicated stage converts from source — no skip report needed. */
const HANDLED_BY_STAGE = new Set(["painting", "font"]);

/**
 * Copies vanilla-namespace textures into their Bedrock locations using the
 * remap table. Custom-namespace textures are NOT copied here — the item,
 * geometry, armor, blocks, and font stages re-encode whatever they reference
 * into textures/geyser_custom/. The only exception is animated custom block
 * textures, which the flipbooks stage copies on demand for its flipbook entry.
 * This avoids copying ~1000+ textures that the optimizer would later sweep.
 */
export const texturesStage: PipelineStage = {
  name: "textures",
  run(ctx: ConversionContext): void {
    const paths = ctx.java.list({ prefix: "assets/", suffix: ".png" });
    let done = 0;
    for (const path of paths) {
      done++;
      if (done % 100 === 0) ctx.progress("textures", done, paths.length);

      if (path.startsWith("assets/minecraft/textures/")) {
        const remap = remapVanillaTexture(path);
        if (remap === undefined) {
          const category = path.slice("assets/minecraft/textures/".length).split("/")[0] ?? "";
          if (!VANILLA_TEXTURE_CATEGORIES.has(category)) {
            // Custom content dumped under the minecraft namespace (armour sets,
            // glyph sheets). The owning stage re-encodes what it references;
            // skip copying — the optimizer sweep would delete it anyway.
            continue;
          }
          // A real vanilla category we don't remap here: painting/font are
          // converted from source by their own stage (silent); the rest have no
          // Bedrock equivalent yet.
          if (!HANDLED_BY_STAGE.has(category)) {
            ctx.report.skipped("textures", path, `vanilla ${category} textures have no Bedrock equivalent yet`);
          }
          continue;
        }
        const data = ctx.java.read(path);
        if (data === undefined) continue;
        ctx.bedrock.write(remap.outputPath, data);
        if (remap.exact) {
          ctx.report.converted("textures", path, [remap.outputPath]);
        } else {
          ctx.report.approximated(
            "textures",
            path,
            "no explicit rename rule — copied with same filename (correct for most modern textures)",
            [remap.outputPath],
          );
        }
        // mcmeta files are read directly from ctx.java by the flipbook stage,
        // so no need to copy them here.
        continue;
      }

      // Custom-namespace textures: NOT copied here. The consuming stages
      // (items, geometry, armor, blocks, fonts) decode from ctx.java and
      // re-encode into textures/geyser_custom/. The flipbooks stage copies
      // animated custom block textures on demand. This saves ~1200 dead
      // VFS writes + the same memory + the optimizer sweep.
    }
    ctx.progress("textures", paths.length, paths.length);
  },
};
