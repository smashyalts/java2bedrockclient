import type { ConversionContext, PipelineStage } from "../context.js";
import { blit, createImage, crop, decodePng, encodePng, flipVertical, rotate180, type RgbaImage } from "../../image/png.js";

/**
 * Entity texture composites. Java 1.15+ rearranged chest texture layouts and
 * split double chests into left/right halves; Bedrock kept the legacy layout
 * with a single double-chest sheet. This stage rewrites the passthrough chest
 * textures into Bedrock's layout and stitches double chests.
 *
 * Region math ported from ConvertJavaTextureToBedrock (rtm516/ozelot379),
 * coordinates in 64px space scaled by width/64 for HD packs.
 */

type Op = {
  /** source: crop rect in 64-space */
  sx: number; sy: number; w: number; h: number;
  /** transform applied to the cropped region */
  t: "rot180" | "flipV" | "none";
  /** destination position in 64-space */
  dx: number; dy: number;
  /** which source image (double chests only) */
  src?: "left" | "right";
};

const SINGLE_CHEST_OPS: Op[] = [
  { sx: 0, sy: 14, w: 14, h: 5, t: "rot180", dx: 0, dy: 14 },
  { sx: 0, sy: 33, w: 14, h: 10, t: "rot180", dx: 0, dy: 33 },
  { sx: 28, sy: 0, w: 14, h: 14, t: "flipV", dx: 14, dy: 0 },
  { sx: 42, sy: 14, w: 14, h: 5, t: "rot180", dx: 14, dy: 14 },
  { sx: 28, sy: 19, w: 14, h: 14, t: "flipV", dx: 14, dy: 19 },
  { sx: 42, sy: 33, w: 14, h: 10, t: "rot180", dx: 14, dy: 33 },
  { sx: 14, sy: 0, w: 14, h: 14, t: "flipV", dx: 28, dy: 0 },
  { sx: 28, sy: 14, w: 14, h: 5, t: "rot180", dx: 28, dy: 14 },
  { sx: 14, sy: 19, w: 14, h: 14, t: "flipV", dx: 28, dy: 19 },
  { sx: 28, sy: 33, w: 14, h: 10, t: "rot180", dx: 28, dy: 33 },
  { sx: 14, sy: 14, w: 14, h: 5, t: "rot180", dx: 42, dy: 14 },
  { sx: 14, sy: 33, w: 14, h: 10, t: "rot180", dx: 42, dy: 33 },
  { sx: 0, sy: 0, w: 6, h: 6, t: "none", dx: 0, dy: 0 },
];

const DOUBLE_CHEST_OPS: Op[] = [
  { src: "right", sx: 0, sy: 14, w: 14, h: 5, t: "rot180", dx: 0, dy: 14 },
  { src: "left", sx: 29, sy: 14, w: 14, h: 5, t: "rot180", dx: 44, dy: 14 },
  { src: "right", sx: 0, sy: 33, w: 14, h: 10, t: "rot180", dx: 0, dy: 33 },
  { src: "left", sx: 29, sy: 33, w: 14, h: 10, t: "rot180", dx: 44, dy: 33 },
  { src: "right", sx: 29, sy: 0, w: 15, h: 14, t: "flipV", dx: 14, dy: 0 },
  { src: "left", sx: 29, sy: 0, w: 15, h: 14, t: "flipV", dx: 29, dy: 0 },
  { src: "right", sx: 43, sy: 14, w: 15, h: 5, t: "rot180", dx: 14, dy: 14 },
  { src: "left", sx: 43, sy: 14, w: 15, h: 5, t: "rot180", dx: 29, dy: 14 },
  { src: "right", sx: 29, sy: 19, w: 15, h: 14, t: "flipV", dx: 14, dy: 19 },
  { src: "left", sx: 29, sy: 19, w: 15, h: 14, t: "flipV", dx: 29, dy: 19 },
  { src: "right", sx: 43, sy: 33, w: 15, h: 10, t: "rot180", dx: 14, dy: 33 },
  { src: "left", sx: 43, sy: 33, w: 15, h: 10, t: "rot180", dx: 29, dy: 33 },
  { src: "right", sx: 14, sy: 0, w: 15, h: 14, t: "flipV", dx: 44, dy: 0 },
  { src: "left", sx: 14, sy: 0, w: 15, h: 14, t: "flipV", dx: 59, dy: 0 },
  { src: "left", sx: 14, sy: 14, w: 15, h: 5, t: "rot180", dx: 58, dy: 14 },
  { src: "right", sx: 14, sy: 14, w: 15, h: 5, t: "rot180", dx: 73, dy: 14 },
  { src: "left", sx: 14, sy: 33, w: 15, h: 10, t: "rot180", dx: 58, dy: 33 },
  { src: "right", sx: 14, sy: 33, w: 15, h: 10, t: "rot180", dx: 73, dy: 33 },
  { src: "left", sx: 0, sy: 0, w: 6, h: 6, t: "none", dx: 0, dy: 0 },
];

function applyOps(
  out: RgbaImage,
  ops: Op[],
  factor: number,
  images: { left: RgbaImage; right: RgbaImage },
): void {
  for (const op of ops) {
    const source = op.src === "left" ? images.left : images.right;
    let region = crop(source, op.sx * factor, op.sy * factor, op.w * factor, op.h * factor);
    if (op.t === "rot180") region = rotate180(region);
    else if (op.t === "flipV") region = flipVertical(region);
    blit(out, region, op.dx * factor, op.dy * factor);
  }
}

const SINGLE_CHESTS = ["normal", "trapped", "ender", "christmas"];
const DOUBLE_CHESTS: [string, string, string][] = [
  ["normal_left", "normal_right", "double_normal"],
  ["trapped_left", "trapped_right", "trapped_double"],
  ["christmas_left", "christmas_right", "christmas_double"],
];

export const entityCompositesStage: PipelineStage = {
  name: "entity-composites",
  run(ctx: ConversionContext): void {
    // Java 1.15 (pack_format 5) changed the chest layout; older packs already
    // match Bedrock's layout and pass through untouched.
    if (ctx.java.packFormat < 5) return;

    for (const chest of SINGLE_CHESTS) {
      const path = `textures/entity/chest/${chest}.png`;
      const bytes = ctx.bedrock.read(path);
      if (bytes === undefined) continue;
      try {
        const image = decodePng(bytes);
        const factor = Math.max(1, Math.floor(image.width / 64));
        const out = createImage(64 * factor, 64 * factor);
        applyOps(out, SINGLE_CHEST_OPS, factor, { left: image, right: image });
        ctx.bedrock.write(path, encodePng(out));
        ctx.report.converted("entity-composites", path, ["chest layout rearranged for Bedrock"]);
      } catch (err) {
        ctx.report.error("entity-composites", path, err instanceof Error ? err.message : String(err));
      }
    }

    for (const [left, right, to] of DOUBLE_CHESTS) {
      const leftPath = `textures/entity/chest/${left}.png`;
      const rightPath = `textures/entity/chest/${right}.png`;
      const leftBytes = ctx.bedrock.read(leftPath);
      const rightBytes = ctx.bedrock.read(rightPath);
      if (leftBytes === undefined || rightBytes === undefined) continue;
      try {
        const leftImage = decodePng(leftBytes);
        const rightImage = decodePng(rightBytes);
        const factor = Math.max(1, Math.floor(leftImage.width / 64));
        const out = createImage(128 * factor, 64 * factor);
        applyOps(out, DOUBLE_CHEST_OPS, factor, { left: leftImage, right: rightImage });
        ctx.bedrock.write(`textures/entity/chest/${to}.png`, encodePng(out));
        // Bedrock has no left/right halves.
        ctx.bedrock.delete(leftPath);
        ctx.bedrock.delete(rightPath);
        ctx.report.converted("entity-composites", `${leftPath} + ${rightPath}`, [
          `textures/entity/chest/${to}.png stitched`,
        ]);
      } catch (err) {
        ctx.report.error("entity-composites", leftPath, err instanceof Error ? err.message : String(err));
      }
    }
  },
};
