import { createImage, type RgbaImage } from "./png.js";

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
 * Packs textures into a square-ish grid atlas. Bedrock geometry references a
 * single texture, so multi-texture Java models get their textures stitched and
 * UVs remapped into atlas pixel space.
 *
 * Tiles use the max texture dimensions so grid math stays trivial; smaller
 * textures sit in the top-left of their tile (UVs reference original size).
 */
export function buildAtlas(textures: Map<string, RgbaImage>): Atlas {
  const ids = [...textures.keys()];
  if (ids.length === 0) throw new Error("atlas needs at least one texture");

  const tileW = Math.max(...[...textures.values()].map((t) => t.width));
  const tileH = Math.max(...[...textures.values()].map((t) => t.height));
  const columns = Math.ceil(Math.sqrt(ids.length));
  const rows = Math.ceil(ids.length / columns);

  const image = createImage(columns * tileW, rows * tileH);
  const placements = new Map<string, AtlasPlacement>();

  ids.forEach((id, index) => {
    const tex = textures.get(id)!;
    const x = (index % columns) * tileW;
    const y = Math.floor(index / columns) * tileH;
    blit(image, tex, x, y);
    placements.set(id, { x, y, width: tex.width, height: tex.height });
  });

  return { image, placements };
}

function blit(dst: RgbaImage, src: RgbaImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const srcRow = y * src.width * 4;
    const dstRow = ((dy + y) * dst.width + dx) * 4;
    dst.data.set(src.data.subarray(srcRow, srcRow + src.width * 4), dstRow);
  }
}
