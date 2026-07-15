import { createImage, type RgbaImage } from "./png.js";
import { timeOp } from "../report/timings.js";

export interface AtlasPlacement {
  /** Pixel offset of this texture's tile in the atlas. */
  x: number;
  y: number;
  /** Original texture size in pixels. */
  width: number;
  height: number;
}

export interface Atlas {
  image: RgbaImage;
  placements: Map<string, AtlasPlacement>;
}

/**
 * Packs textures into a square-ish atlas. Bedrock geometry references a single
 * texture, so multi-texture Java models get their textures stitched and UVs
 * remapped into atlas pixel space.
 *
 * Shelf packer (next-fit, height-sorted): rows are as wide as a square grid of
 * the widest tile but only as TALL as the tallest tile they actually hold, so a
 * model mixing texture sizes (16px + 32px) no longer pads every tile to the max
 * — the atlas shrinks with no pixel or UV change. For uniform-size textures the
 * layout is byte-identical to the old max-tile grid. Placements are keyed by id,
 * so packing order never affects geometry UVs; the order is deterministic
 * (height desc, stable) so every animation frame stitches the same way.
 */
export function buildAtlas(textures: Map<string, RgbaImage>): Atlas {
  return timeOp("atlas.build", () => buildAtlasUntimed(textures));
}

function buildAtlasUntimed(textures: Map<string, RgbaImage>): Atlas {
  const ids = [...textures.keys()];
  if (ids.length === 0) throw new Error("atlas needs at least one texture");

  const maxW = Math.max(...[...textures.values()].map((t) => t.width));
  // Row width matches a square grid of the widest tile — for uniform tiles this
  // reproduces the old columns×maxW layout exactly.
  const shelfWidth = Math.ceil(Math.sqrt(ids.length)) * maxW;
  // Tallest tiles first so short tiles fill the gaps rather than heightening a
  // shelf that already carries a tall tile.
  const ordered = ids.sort((a, b) => textures.get(b)!.height - textures.get(a)!.height);

  const placements = new Map<string, AtlasPlacement>();
  let x = 0;
  let y = 0;
  let shelfH = 0;
  let atlasW = 0;
  for (const id of ordered) {
    const tex = textures.get(id)!;
    if (x > 0 && x + tex.width > shelfWidth) {
      y += shelfH; // start a new shelf
      x = 0;
      shelfH = 0;
    }
    placements.set(id, { x, y, width: tex.width, height: tex.height });
    x += tex.width;
    shelfH = Math.max(shelfH, tex.height);
    atlasW = Math.max(atlasW, x);
  }
  const atlasH = y + shelfH;

  const image = createImage(atlasW, atlasH);
  for (const [id, p] of placements) blit(image, textures.get(id)!, p.x, p.y);

  return { image, placements };
}

function blit(dst: RgbaImage, src: RgbaImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const srcRow = y * src.width * 4;
    const dstRow = ((dy + y) * dst.width + dx) * 4;
    dst.data.set(src.data.subarray(srcRow, srcRow + src.width * 4), dstRow);
  }
}
