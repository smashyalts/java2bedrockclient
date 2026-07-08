import type { ConversionContext, PipelineStage } from "../context.js";
import { remapVanillaTexture } from "../../data/vanillaTextureMap.js";
import { parseLenientJson } from "../../java/json.js";

interface McmetaAnimation {
  animation?: {
    frametime?: number;
    frames?: (number | { index: number; time?: number })[];
    interpolate?: boolean;
  };
}

/**
 * Converts .png.mcmeta flipbook animations on block textures into Bedrock's
 * flipbook_textures.json. Item icon animations are handled (cropped) by the
 * items stage; entity/attachable texture animations have no Bedrock analogue.
 */
export const flipbooksStage: PipelineStage = {
  name: "flipbooks",
  run(ctx: ConversionContext): void {
    const flipbooks: object[] = [];
    for (const path of ctx.java.list({ prefix: "assets/", suffix: ".png.mcmeta" })) {
      const meta = parseLenientJson<McmetaAnimation>(ctx.java.readText(path) ?? "");
      if (meta?.animation === undefined) continue;
      const texturePath = path.slice(0, -".mcmeta".length);

      if (!texturePath.startsWith("assets/minecraft/textures/block/")) {
        if (!texturePath.includes("/textures/item/")) {
          ctx.report.skipped(
            "flipbooks",
            path,
            "animation on a non-block texture — Bedrock only animates atlas textures via flipbook_textures.json",
          );
        }
        continue;
      }

      const remap = remapVanillaTexture(texturePath);
      if (remap === undefined) continue;
      const atlasTile = remap.outputPath.slice("textures/blocks/".length, -".png".length);
      const anim = meta.animation;
      const entry: Record<string, unknown> = {
        flipbook_texture: remap.outputPath.slice(0, -".png".length),
        atlas_tile: atlasTile,
        ticks_per_frame: anim.frametime ?? 1,
      };
      if (anim.frames !== undefined) {
        // Bedrock frames are plain indices; per-frame times are not supported.
        entry["frames"] = anim.frames.map((f) => (typeof f === "number" ? f : f.index));
        if (anim.frames.some((f) => typeof f !== "number" && f.time !== undefined)) {
          ctx.report.approximated("flipbooks", path, "per-frame times not supported on Bedrock — uniform frametime used");
        }
      }
      if (anim.interpolate === true) entry["blend_frames"] = true;
      flipbooks.push(entry);
      ctx.report.converted("flipbooks", path, ["textures/flipbook_textures.json"]);
    }

    if (flipbooks.length > 0) {
      ctx.bedrock.writeJson("textures/flipbook_textures.json", flipbooks);
    }
  },
};
