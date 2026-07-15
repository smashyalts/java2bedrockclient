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
 * remap table. Non-minecraft namespaces are handled by the custom item stages
 * (their textures only matter where models reference them), but we still copy
 * them under a namespaced folder so nothing is lost.
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
            // glyph sheets). The item/armour/font stages re-encode whatever they
            // reference; copy the source so any path reference survives, and let
            // the optimizer's dead-file sweep drop the rest. No report noise —
            // the owning stage reports the real conversion.
            const data = ctx.java.read(path);
            if (data !== undefined) {
              ctx.bedrock.write(`textures/${path.slice("assets/minecraft/textures/".length)}`, data);
            }
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

      // Custom-namespace texture: keep it addressable for models/attachables.
      const match = path.match(/^assets\/([^/]+)\/textures\/(.+)$/);
      if (match) {
        const [, ns, rest] = match;
        const out = `textures/${ns}/${rest}`;
        const data = ctx.java.read(path);
        if (data !== undefined) {
          ctx.bedrock.write(out, data);
          ctx.report.converted("textures", path, [out]);
        }
      }
    }
    ctx.progress("textures", paths.length, paths.length);
  },
};
