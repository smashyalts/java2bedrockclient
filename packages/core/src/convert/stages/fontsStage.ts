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
  /**
   * Java bitmap-provider `height`: how tall the glyph renders, in the same
   * units as the 8px text line, *regardless* of its source resolution. This is
   * the only size that matters — two glyphs sharing a height render the same
   * size in Java even if one ships an 8px texture and the other a 96px one.
   */
  height: number;
}

/**
 * Ascents beyond this are positioning tricks, not glyph metrics: packs push a
 * glyph far off-screen (e.g. ascent -42069) to hide it. Bedrock cannot offset
 * that far, so rendering such a glyph normally would make a deliberately hidden
 * element visible — drop it instead.
 */
const MAX_SANE_ASCENT = 64;

/**
 * Sheet size ceiling. Bedrock clients cap resource-pack textures at 4096 on
 * desktop and lower on mobile; a sheet over the cap fails to load and takes
 * every glyph on that page with it. 2048 (128px cells) is comfortably inside
 * every platform's limit and still far finer than vanilla's 16px cells.
 */
const MAX_CELL = 128;

/**
 * Cell fraction the page's typical glyph is drawn at.
 *
 * Bedrock has no per-glyph height metric: a glyph's rendered size is set by how
 * much of its cell the art covers. So Java's `height` has to become a coverage
 * fraction, and something has to anchor it. The page's median height renders at
 * this much of its cell, everything else in proportion, clamped to a full cell
 * — a glyph can't be drawn larger than the cell holding it, which is why Java
 * heights well above the median (banners meant to tower over the text) come out
 * smaller than they do in Java.
 *
 * 0.75 matches the coverage of glyphs that were already rendering at a sensible
 * size before heights were honoured at all.
 */
const MEDIAN_COVERAGE = 0.75;

/**
 * Codepoint pages we must never emit a sheet for.
 *
 * A `font/glyph_XX.png` *replaces* Bedrock's own sheet for that page — the 256
 * cells we leave transparent are not "unset", they're blank characters. Page 00
 * is Basic Latin + Latin-1: every letter, digit and punctuation mark in ordinary
 * text. Packs routinely override two or three ASCII codepoints for decoration
 * (ItemsAdder skins `A`, `!` and `@` for its GUI titles), and honouring that
 * would erase the entire alphabet to gain three ornaments.
 */
const RESERVED_PAGES = new Set([0x00]);

/**
 * Converts bitmap font providers into Bedrock glyph page sheets
 * (font/glyph_XX.png — a 16×16 grid of the 256 codepoints in page XX).
 *
 * Bedrock renders glyph cells at their native pixel data (advance from the
 * opaque width), so — matching known-working converters — glyphs are drawn at
 * NATIVE resolution anchored top-left, and a page's cell is sized to the
 * glyphs on it, bounded by {@link MAX_CELL} and ignoring outliers
 * ({@link OUTSIZED_RATIO}). Java's per-provider `height` has no Bedrock
 * equivalent; `ascent` is baked into the glyph's position within its cell.
 *
 * Note what a sheet means: writing `font/glyph_XX.png` replaces Bedrock's whole
 * sheet for that page, so a page we emit must be one we can fill — see
 * {@link RESERVED_PAGES}.
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
                height: provider.height ?? 8,
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

    for (const [page, all] of byPage) {
      const hexPage = page.toString(16).toUpperCase().padStart(2, "0");
      if (RESERVED_PAGES.has(page)) {
        ctx.report.skipped(
          "fonts",
          `glyph page U+${hexPage}xx`,
          `${all.length} glyph(s) override ordinary text characters — emitting this page would replace Bedrock's own sheet and blank every character the pack doesn't define`,
        );
        continue;
      }

      // Everything below is in Java line units (the same units as `height` and
      // `ascent`), converted to cell pixels once via `perUnit`. Source
      // resolution is deliberately not part of it: Java scales a provider's
      // texture to its `height`, so an 8px and a 96px source with the same
      // height must come out the same size.
      const heights = all.map((g) => g.height).sort((a, b) => a - b);
      const medianHeight = Math.max(1, heights[heights.length >> 1]!);
      const cell = Math.min(MAX_CELL, Math.max(16, ...all.map((g) => Math.max(g.w, g.h))));
      const perUnit = (cell * MEDIAN_COVERAGE) / medianHeight;

      // Vertical alignment: a glyph whose ascent sits below the page's highest
      // is drawn that much further down its cell, preserving how the pack
      // stacked rank tags against inline icons.
      const topAscent = Math.max(...all.map((g) => g.ascent));

      const sheet = createImage(cell * 16, cell * 16);
      for (const g of all) {
        // Fit the glyph's Java height into the cell, keeping its aspect ratio;
        // anything taller than a cell simply fills it.
        const scale = Math.min(g.height * perUnit, cell) / g.h;
        const drawW = Math.max(1, Math.min(cell, Math.round(g.w * scale)));
        const drawH = Math.max(1, Math.min(cell, Math.round(g.h * scale)));
        const dyOff = Math.max(0, Math.min(Math.round((topAscent - g.ascent) * perUnit), cell - drawH));
        const dx = (g.index % 16) * cell;
        const dy = Math.floor(g.index / 16) * cell + dyOff;
        scaledBlit(sheet, g.image, g.sx, g.sy, g.w, g.h, dx, dy, drawW, drawH);
      }
      ctx.bedrock.write(`font/glyph_${hexPage}.png`, encodePng(sheet));
    }
  },
};

/**
 * Copy a `w`x`h` region of `src` into a `drawW`x`drawH` box in `dst`, sampling
 * nearest-neighbour. Nearest, not bilinear: these are pixel-art glyphs, and
 * smoothing them turns crisp 8px icons into blur when scaled up to a cell.
 */
function scaledBlit(
  dst: RgbaImage,
  src: RgbaImage,
  sx: number,
  sy: number,
  w: number,
  h: number,
  dx: number,
  dy: number,
  drawW: number,
  drawH: number,
): void {
  for (let y = 0; y < drawH; y++) {
    if (dy + y >= dst.height) break;
    const srcY = sy + Math.min(h - 1, Math.floor((y * h) / drawH));
    if (srcY >= src.height) break;
    for (let x = 0; x < drawW; x++) {
      if (dx + x >= dst.width) break;
      const srcX = sx + Math.min(w - 1, Math.floor((x * w) / drawW));
      if (srcX >= src.width) break;
      const si = (srcY * src.width + srcX) * 4;
      const di = ((dy + y) * dst.width + (dx + x)) * 4;
      dst.data[di] = src.data[si]!;
      dst.data[di + 1] = src.data[si + 1]!;
      dst.data[di + 2] = src.data[si + 2]!;
      dst.data[di + 3] = src.data[si + 3]!;
    }
  }
}

