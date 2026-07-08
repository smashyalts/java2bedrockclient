import type { ConversionContext, PipelineStage } from "../context.js";
import { createImage, decodePng, encodePng, type RgbaImage } from "../../image/png.js";
import { parseResourceLocation } from "../../java/javaPack.js";

interface FontProvider {
  type: string;
  file?: string;
  height?: number;
  ascent?: number;
  chars?: string[];
}

interface FontAsset {
  providers?: FontProvider[];
}

interface GlyphPlacement {
  page: number;
  index: number;
  image: RgbaImage;
  sx: number;
  sy: number;
  w: number;
  h: number;
}

/**
 * Converts bitmap font providers into Bedrock glyph page sheets
 * (font/glyph_XX.png — a 16×16 grid of the 256 codepoints in page XX).
 *
 * Bedrock renders glyph cells at their native pixel data (advance from the
 * opaque width), so — matching known-working converters — glyphs are drawn at
 * NATIVE resolution anchored top-left, and each page's cell size is the
 * largest glyph dimension on that page (min 16). Java height/ascent metrics
 * have no Bedrock equivalent and are ignored.
 */
export const fontsStage: PipelineStage = {
  name: "fonts",
  run(ctx: ConversionContext): void {
    // Pass 1: collect all glyphs with their source regions.
    const placements: GlyphPlacement[] = [];
    const taken = new Set<number>(); // page<<8 | index — first definition wins
    const textureCache = new Map<string, RgbaImage | undefined>();

    for (const ns of ctx.java.namespaces()) {
      const prefix = `assets/${ns}/font/`;
      for (const path of ctx.java.list({ prefix, suffix: ".json" })) {
        const asset = ctx.java.readJson<FontAsset>(path);
        if (asset?.providers === undefined) continue;
        let glyphs = 0;
        for (const provider of asset.providers) {
          if (provider.type !== "bitmap") {
            ctx.report.skipped("fonts", path, `font provider type "${provider.type}" has no Bedrock equivalent`);
            continue;
          }
          if (provider.file === undefined || provider.chars === undefined || provider.chars.length === 0) continue;

          const loc = parseResourceLocation(provider.file.replace(/\.png$/, ""));
          const texPath = `assets/${loc.namespace}/textures/${loc.path}.png`;
          if (!textureCache.has(texPath)) {
            const bytes = ctx.java.read(texPath);
            textureCache.set(texPath, bytes !== undefined ? decodePng(bytes) : undefined);
          }
          const image = textureCache.get(texPath);
          if (image === undefined) {
            ctx.report.skipped("fonts", path, `bitmap font texture ${provider.file} missing`);
            continue;
          }

          const rows = provider.chars.length;
          const cols = [...provider.chars[0]!].length;
          if (cols === 0) continue;
          const cellW = Math.floor(image.width / cols);
          const cellH = Math.floor(image.height / rows);

          provider.chars.forEach((rowStr, row) => {
            [...rowStr].forEach((ch, col) => {
              const cp = ch.codePointAt(0)!;
              if (cp === 0 || cp === 32) return; // padding chars
              if (cp > 0xffff) return; // outside glyph page range
              const key = cp;
              if (taken.has(key)) return;
              taken.add(key);
              placements.push({
                page: cp >> 8,
                index: cp & 0xff,
                image,
                sx: col * cellW,
                sy: row * cellH,
                w: cellW,
                h: cellH,
              });
              glyphs++;
            });
          });
        }
        if (glyphs > 0) {
          ctx.report.approximated(
            "fonts",
            path,
            `${glyphs} glyph(s) placed at native resolution — Java height/ascent metrics and space-provider offsets have no Bedrock equivalent`,
          );
        }
      }
    }
    if (placements.length === 0) return;

    // Pass 2: per page, size the cell to the largest glyph and draw natively.
    const byPage = new Map<number, GlyphPlacement[]>();
    for (const p of placements) {
      const list = byPage.get(p.page) ?? [];
      list.push(p);
      byPage.set(p.page, list);
    }

    for (const [page, glyphs] of byPage) {
      const cell = Math.max(16, ...glyphs.map((g) => Math.max(g.w, g.h)));
      const sheet = createImage(cell * 16, cell * 16);
      for (const g of glyphs) {
        const dx = (g.index % 16) * cell;
        const dy = Math.floor(g.index / 16) * cell;
        nativeBlit(sheet, g.image, g.sx, g.sy, Math.min(g.w, cell), Math.min(g.h, cell), dx, dy);
      }
      const hex = page.toString(16).toUpperCase().padStart(2, "0");
      ctx.bedrock.write(`font/glyph_${hex}.png`, encodePng(sheet));
    }
  },
};

function nativeBlit(
  dst: RgbaImage,
  src: RgbaImage,
  sx: number,
  sy: number,
  w: number,
  h: number,
  dx: number,
  dy: number,
): void {
  for (let y = 0; y < h; y++) {
    if (sy + y >= src.height || dy + y >= dst.height) break;
    for (let x = 0; x < w; x++) {
      if (sx + x >= src.width || dx + x >= dst.width) break;
      const si = ((sy + y) * src.width + (sx + x)) * 4;
      const di = ((dy + y) * dst.width + (dx + x)) * 4;
      dst.data[di] = src.data[si]!;
      dst.data[di + 1] = src.data[si + 1]!;
      dst.data[di + 2] = src.data[si + 2]!;
      dst.data[di + 3] = src.data[si + 3]!;
    }
  }
}

