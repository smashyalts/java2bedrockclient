import type { ConversionContext, PipelineStage } from "../context.js";
import { createImage, decodeCached, encodePng, scaleNearest, type RgbaImage } from "../../image/png.js";

/**
 * Java paintings are individual textures; Bedrock uses the legacy combined
 * atlas (textures/painting/kz.png, 256×256 base). Positions match the
 * pre-1.14 Java paintings_kristoffer_zetterstrand.png layout.
 * [x, y, w, h] in base pixels.
 */
const PAINTING_SLOTS: Record<string, [number, number, number, number]> = {
  kebab: [0, 0, 16, 16],
  aztec: [16, 0, 16, 16],
  alban: [32, 0, 16, 16],
  aztec2: [48, 0, 16, 16],
  bomb: [64, 0, 16, 16],
  plant: [80, 0, 16, 16],
  wasteland: [96, 0, 16, 16],
  back: [192, 0, 16, 16],
  pool: [0, 32, 32, 16],
  courbet: [32, 32, 32, 16],
  sea: [64, 32, 32, 16],
  sunset: [96, 32, 32, 16],
  creebet: [128, 32, 32, 16],
  wanderer: [0, 64, 16, 32],
  graham: [16, 64, 16, 32],
  fighters: [0, 96, 64, 32],
  match: [0, 128, 32, 32],
  bust: [32, 128, 32, 32],
  stage: [64, 128, 32, 32],
  void: [96, 128, 32, 32],
  skull_and_roses: [128, 128, 32, 32],
  wither: [160, 128, 32, 32],
  pointer: [0, 192, 64, 64],
  pigscene: [64, 192, 64, 64],
  burning_skull: [128, 192, 64, 64],
  skeleton: [192, 64, 64, 48],
  donkey_kong: [192, 112, 64, 48],
};

export const paintingsStage: PipelineStage = {
  name: "paintings",
  run(ctx: ConversionContext): void {
    const prefix = "assets/minecraft/textures/painting/";
    const paths = ctx.java.list({ prefix, suffix: ".png" });
    if (paths.length === 0) return;

    // Determine upscale factor from the highest-resolution provided painting.
    let scale = 1;
    const images = new Map<string, RgbaImage>();
    for (const path of paths) {
      const name = path.slice(prefix.length, -".png".length);
      const slot = PAINTING_SLOTS[name];
      if (slot === undefined) {
        ctx.report.skipped("paintings", path, `unknown painting "${name}" — not in the Bedrock kz.png atlas`);
        continue;
      }
      const img = decodeCached(ctx.java.read.bind(ctx.java), path, ctx.textureCache);
      if (img === undefined) continue;
      images.set(name, img);
      scale = Math.max(scale, Math.round(img.width / slot[2]));
    }
    if (images.size === 0) return;

    const atlas = createImage(256 * scale, 256 * scale);
    for (const [name, img] of images) {
      const [x, y, w, h] = PAINTING_SLOTS[name]!;
      const scaled = scaleNearest(img, w * scale, h * scale);
      for (let row = 0; row < scaled.height; row++) {
        const srcOff = row * scaled.width * 4;
        const dstOff = ((y * scale + row) * atlas.width + x * scale) * 4;
        atlas.data.set(scaled.data.subarray(srcOff, srcOff + scaled.width * 4), dstOff);
      }
      ctx.report.converted("paintings", prefix + name + ".png", ["textures/painting/kz.png"]);
    }

    ctx.bedrock.write("textures/painting/kz.png", encodePng(atlas));
    if (images.size < Object.keys(PAINTING_SLOTS).length) {
      ctx.report.approximated(
        "paintings",
        "textures/painting/kz.png",
        `pack overrides ${images.size} painting(s); the rest of the atlas is transparent — non-overridden paintings will be invisible on Bedrock. Provide all paintings to avoid this.`,
      );
    }
  },
};
