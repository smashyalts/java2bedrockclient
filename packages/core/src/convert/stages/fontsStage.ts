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
 * Sheet size ceiling. Bedrock clients cap resource-pack textures at 4096 on
 * desktop and lower on mobile; a sheet over the cap fails to load and takes
 * every glyph on that page with it. 2048 (128px cells) is comfortably inside
 * every platform's limit and still far finer than vanilla's 16px cells.
 */
const MAX_CELL = 128;

/**
 * Java gives every bitmap provider its own `height`, so a 256px banner and an
 * 8px status icon can share a codepoint page and each render at its own size.
 * Bedrock has one cell size per page and renders a glyph proportionally to how
 * much of its cell the art fills — so those two cannot coexist. Sizing the cell
 * to the banner shrinks the icons to nothing; sizing it to the icons crops the
 * banner.
 *
 * A glyph more than this many times the page's median extent is treated as the
 * odd one out and dropped, so the rest of the page survives. Dropping one
 * oversized decoration beats losing every icon next to it.
 */
const OUTSIZED_RATIO = 4;

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

      // Bake the Java ascent into vertical position. Bedrock has no per-glyph
      // metric — every glyph would otherwise sit flush to the top of its cell,
      // so glyphs authored at different heights (rank tags vs inline icons)
      // lose their relative alignment. Drop each glyph inside its cell by how
      // far its ascent sits below the page's highest, preserving that offset.
      const topAscent = Math.max(...all.map((g) => g.ascent));
      const drop = (g: GlyphPlacement): number => Math.round(topAscent - g.ascent);
      const extent = (g: GlyphPlacement): number => Math.max(g.w, g.h + drop(g));

      // Keep the bulk of the page at one scale; an outlier many times larger
      // would otherwise set the cell size and shrink everything else to
      // nothing. Median, not mean, so a couple of banners can't drag it up.
      const sorted = [...all].map(extent).sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1]!;
      const glyphs = all.filter((g) => extent(g) <= median * OUTSIZED_RATIO);
      const dropped = all.length - glyphs.length;
      if (dropped > 0) {
        ctx.report.skipped(
          "fonts",
          `glyph page U+${hexPage}xx`,
          `${dropped} oversized glyph(s) dropped — more than ${OUTSIZED_RATIO}× the other glyphs on this page, and Bedrock has one cell size per page, so keeping them would shrink every other glyph on the page to nothing`,
        );
      }
      if (glyphs.length === 0) continue;

      const cell = Math.min(MAX_CELL, Math.max(16, ...glyphs.map(extent)));
      const sheet = createImage(cell * 16, cell * 16);
      for (const g of glyphs) {
        const dyOff = Math.min(drop(g), cell - 1);
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
      ctx.bedrock.write(`font/glyph_${hexPage}.png`, encodePng(sheet));
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

