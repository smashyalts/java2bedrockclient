import type { ConversionContext, PipelineStage } from "../context.js";
import { remapVanillaTexture } from "../../data/vanillaTextureMap.js";

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
          // Composite or special-cased category — a dedicated stage owns it.
          // Only report if no stage will ever pick it up (gui/painting/particle
          // handled later; font intentionally deferred).
          ctx.report.skipped("textures", path, "special category — handled by a dedicated stage or not yet supported");
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
        // Copy the mcmeta alongside so the flipbook stage can find it later.
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
