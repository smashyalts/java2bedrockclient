import type { ConversionContext, PipelineStage } from "../context.js";
import { createImage, decodeCached, encodePng, type RgbaImage } from "../../image/png.js";
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
  /** Java bitmap-provider ascent — higher means drawn higher up the line. */
  ascent: number;
}

/**
 * Ascents beyond this are positioning tricks, not glyph metrics: packs push a
 * glyph far off-screen (e.g. ascent -42069) to hide it. Bedrock cannot offset
 * that far, so rendering such a glyph normally would make a deliberately hidden
 * element visible — drop it instead.
 */
const MAX_SANE_ASCENT = 64;

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
    let hiddenGlyphs = 0;

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
          const image = decodeCached(ctx.java.read.bind(ctx.java), texPath, ctx.textureCache);
          if (image === undefined) {
            ctx.report.skipped("fonts", path, `bitmap font texture ${provider.file} missing`);
            continue;
          }

          const ascent = provider.ascent ?? 0;
          if (Math.abs(ascent) > MAX_SANE_ASCENT) {
            hiddenGlyphs += provider.chars.reduce((n, row) => n + [...row].length, 0);
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
                ascent,
              });
              glyphs++;
            });
          });
        }
        if (glyphs > 0) {
          ctx.report.approximated(
            "fonts",
            path,
            `${glyphs} glyph(s) placed at native resolution with the Java ascent baked into the cell — height scaling and space-provider offsets have no Bedrock equivalent`,
          );
        }
        if (hiddenGlyphs > 0) {
          ctx.report.skipped(
            "fonts",
            path,
            `${hiddenGlyphs} glyph(s) hidden in Java by an off-screen ascent (|ascent| > ${MAX_SANE_ASCENT}) — Bedrock cannot offset that far, so they are dropped rather than shown`,
          );
          hiddenGlyphs = 0;
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
      // Bake the Java ascent into vertical position. Bedrock has no per-glyph
      // metric — every glyph would otherwise sit flush to the top of its cell,
      // so glyphs authored at different heights (rank tags vs inline icons)
      // lose their relative alignment. Drop each glyph inside its cell by how
      // far its ascent sits below the page's highest, preserving that offset.
      const topAscent = Math.max(...glyphs.map((g) => g.ascent));
      const drop = (g: GlyphPlacement): number => Math.round(topAscent - g.ascent);
      const cell = Math.max(16, ...glyphs.map((g) => Math.max(g.w, g.h + drop(g))));
      const sheet = createImage(cell * 16, cell * 16);
      for (const g of glyphs) {
        const dyOff = drop(g);
        const dx = (g.index % 16) * cell;
        const dy = Math.floor(g.index / 16) * cell + dyOff;
        nativeBlit(
          sheet,
          g.image,
          g.sx,
          g.sy,
          Math.min(g.w, cell),
          Math.min(g.h, cell - dyOff),
          dx,
          dy,
        );
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

