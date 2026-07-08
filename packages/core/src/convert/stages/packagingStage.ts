import type { ConversionContext, PipelineStage } from "../context.js";
import { buildManifest } from "../../bedrock/manifest.js";

/** Emits manifest.json, pack_icon.png, and flushes accumulated registries. */
export const packagingStage: PipelineStage = {
  name: "packaging",
  run(ctx: ConversionContext): void {
    const description =
      typeof ctx.java.mcmeta?.pack?.description === "string"
        ? (ctx.java.mcmeta.pack.description as string)
        : `Converted from Java Edition by GeyserConverter`;

    ctx.bedrock.writeJson(
      "manifest.json",
      buildManifest({ name: ctx.options.packName, description }),
    );

    const packPng = ctx.java.read("pack.png");
    if (packPng !== undefined) {
      ctx.bedrock.write("pack_icon.png", packPng);
      ctx.report.converted("packaging", "pack.png", ["pack_icon.png"]);
    }

    if (ctx.itemTextures.size > 0) {
      ctx.bedrock.writeJson("textures/item_texture.json", {
        resource_pack_name: ctx.options.packName,
        texture_name: "atlas.items",
        texture_data: Object.fromEntries(ctx.itemTextures),
      });
    }

    if (ctx.terrainTextures.size > 0) {
      ctx.bedrock.writeJson("textures/terrain_texture.json", {
        resource_pack_name: ctx.options.packName,
        texture_name: "atlas.terrain",
        padding: 8,
        num_mip_levels: 4,
        texture_data: Object.fromEntries(ctx.terrainTextures),
      });
    }
  },
};
