import type {
  ConversionContext,
  GeyserBlockDefinition,
  GeyserMaterialInstance,
  PipelineStage,
} from "../context.js";
import { resolveModel, resolveTextureRef, type ResolvedModel } from "../../resolve/modelResolver.js";
import { buildGeometry } from "../../bedrock/geometry.js";
import { alphaBleed, decodeCached, encodePng, firstFrame, type RgbaImage } from "../../image/png.js";
import { buildAtlas } from "../../image/atlas.js";
import { safeName } from "./itemsStage.js";
import { fitFilePath, fitPathName } from "../../util/packPath.js";
import { parseResourceLocation } from "../../java/javaPack.js";
import type { JavaElement, JavaFaceName } from "../../java/model.js";

/**
 * Path budget for block names (see {@link fitPathName}): terrain_texture.json
 * points at the texture by path, so that template sets the limit. The geometry
 * file is found by the identifier inside it and gets {@link fitFilePath}.
 */
const BLOCK_TEXTURE_PATH_RESERVED = "textures/geyser_custom/blocks/.png".length;

/**
 * Custom blocks. Oraxen / ItemsAdder / Nexo implement custom blocks by
 * overriding the blockstates of "mechanic" vanilla blocks (note_block,
 * tripwire, mushroom blocks) — each state combination renders a custom model.
 * We convert those blockstate variants into Geyser custom block mappings
 * (format_version 1) with per-state overrides, plus the Bedrock-side
 * geometry + terrain_texture entries.
 */

/**
 * Vanilla blocks plugins repurpose for custom blocks, with the full property
 * set of each.
 *
 * Geyser resolves a `state_overrides` key by rebuilding `<block>[<key>]` and
 * looking it up in its Java block-state registry, whose keys come from
 * `BlockState.toString()` — every property of the block, in the order Geyser's
 * `Blocks` table declares them (alphabetical for all of these), values
 * lowercased. A key that is reordered, partial, or differently cased is simply
 * not in the registry, and Geyser throws away the whole block entry.
 *
 * Resource-pack blockstate files are under no such constraint: Nexo writes
 * `instrument=harp,powered=false,note=0` for note_block, which has to be
 * reordered before it means anything to Geyser.
 */
const MECHANIC_BLOCKS: Record<string, string[]> = {
  note_block: ["instrument", "note", "powered"],
  tripwire: ["attached", "disarmed", "east", "north", "powered", "south", "west"],
  mushroom_stem: ["down", "east", "north", "south", "up", "west"],
  brown_mushroom_block: ["down", "east", "north", "south", "up", "west"],
  red_mushroom_block: ["down", "east", "north", "south", "up", "west"],
  cave_vines: ["age", "berries"],
  cave_vines_plant: ["berries"],
  chorus_plant: ["down", "east", "north", "south", "up", "west"],
  sugar_cane: ["age"],
};

interface BlockstateVariant {
  model: string;
  /** Clockwise rotations in degrees (multiples of 90). */
  x?: number;
  y?: number;
}

interface BlockstateFile {
  variants?: Record<string, BlockstateVariant | BlockstateVariant[]>;
  multipart?: unknown[];
}

export const blocksStage: PipelineStage = {
  name: "blocks",
  run(ctx: ConversionContext): void {
    for (const [block, properties] of Object.entries(MECHANIC_BLOCKS)) {
      const path = `assets/minecraft/blockstates/${block}.json`;
      const state = ctx.java.readJson<BlockstateFile>(path);
      if (state === undefined) continue;
      if (state.variants === undefined) {
        if (state.multipart !== undefined) {
          ctx.report.skipped("blocks", path, "multipart blockstates are not yet supported");
        }
        continue;
      }
      try {
        convertBlockstates(ctx, block, path, state.variants, properties);
      } catch (err) {
        ctx.report.error("blocks", path, err instanceof Error ? err.message : String(err));
      }
    }
  },
};

function convertBlockstates(
  ctx: ConversionContext,
  block: string,
  path: string,
  variants: NonNullable<BlockstateFile["variants"]>,
  properties: string[],
): void {
  const overrides: Record<string, Partial<GeyserBlockDefinition>> = {};
  let base: GeyserBlockDefinition | undefined;
  let converted = 0;

  for (const [stateKey, variantRaw] of Object.entries(variants)) {
    const variant = Array.isArray(variantRaw) ? variantRaw[0] : variantRaw;
    if (variant?.model === undefined) continue;

    // Only variants whose model actually ships in the pack are custom.
    const loc = parseResourceLocation(variant.model);
    if (!ctx.java.has(`assets/${loc.namespace}/models/${loc.path}.json`)) continue;

    const resolved = resolveModel(ctx.java, variant.model);
    if (resolved === undefined) continue;

    const def = buildBlockDefinition(ctx, variant.model, resolved);
    if (def === undefined) {
      ctx.report.skipped("blocks", `${path} [${stateKey}]`, `model ${variant.model} has no usable elements/textures`);
      continue;
    }
    // Blockstate x/y rotations (directional blocks/furniture). Java rotates
    // clockwise; Bedrock transformations rotate counter-clockwise.
    const rx = normalizeAngle(-(variant.x ?? 0));
    const ry = normalizeAngle(-(variant.y ?? 0));
    if (rx !== 0 || ry !== 0) {
      (def as Record<string, unknown>)["transformation"] = { rotation: [rx, ry, 0] };
    }
    const geyserStateKey = normalizeStateKey(stateKey, properties);
    if (geyserStateKey === undefined) {
      ctx.report.skipped(
        "blocks",
        `${path} [${stateKey}]`,
        `blockstate key doesn't name every ${block} property (${properties.join(", ")}) — Geyser looks the full state up in its registry and rejects the block if it's missing`,
      );
      continue;
    }
    overrides[geyserStateKey] = def;
    if (base === undefined) {
      base = { name: def.name ?? safeName(variant.model), ...def };
      // A rotated variant's transformation must not become the block default.
      delete (base as unknown as Record<string, unknown>)["transformation"];
    }
    converted++;
  }

  if (base === undefined || converted === 0) return;

  ctx.geyserBlocks[`minecraft:${block}`] = {
    ...base,
    only_override_states: true,
    state_overrides: overrides,
  };
  ctx.report.converted("blocks", path, [`${converted} custom block state(s) mapped`]);
}

/**
 * Rewrite a resource-pack blockstate variant key into the exact string Geyser's
 * block-state registry is keyed by: every property of the block, sorted by
 * property name, values lowercased. Returns undefined when the key can't be
 * made to match — a partial key (the pack matched on a subset of properties) or
 * one naming a property the block doesn't have. Emitting those anyway makes
 * Geyser reject the whole block, so they're reported and dropped instead.
 */
function normalizeStateKey(key: string, properties: string[]): string | undefined {
  const trimmed = key.trim();
  if (trimmed === "") return undefined;
  const values = new Map<string, string>();
  for (const pair of trimmed.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) return undefined;
    values.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim().toLowerCase());
  }
  if (values.size !== properties.length) return undefined;
  const parts: string[] = [];
  for (const property of properties) {
    const value = values.get(property);
    if (value === undefined) return undefined;
    parts.push(`${property}=${value}`);
  }
  return parts.join(",");
}

/** Wrap an angle into (-180, 180] in 90° steps. */
function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

const FULL_CUBE_FACES: JavaFaceName[] = ["up", "down", "north", "south", "east", "west"];

function buildBlockDefinition(
  ctx: ConversionContext,
  modelId: string,
  resolved: ResolvedModel,
): (Partial<GeyserBlockDefinition> & { name?: string }) | undefined {
  const name = fitPathName(safeName(modelId), BLOCK_TEXTURE_PATH_RESERVED);
  const elements = resolved.elements ?? [];
  if (elements.length === 0) return undefined;

  // Full 16³ cube → use the builtin full-block geometry with per-face materials.
  const fullCube =
    elements.length === 1 &&
    elements[0]!.from.every((v) => v === 0) &&
    elements[0]!.to.every((v) => v === 16);

  if (fullCube) {
    const materials: Record<string, GeyserMaterialInstance> = {};
    const faceTextures = new Map<JavaFaceName, string>();
    for (const face of FULL_CUBE_FACES) {
      const ref = elements[0]!.faces?.[face]?.texture;
      if (ref === undefined) continue;
      const id = resolveTextureRef(resolved.textures, ref);
      if (id !== undefined) faceTextures.set(face, id);
    }
    if (faceTextures.size === 0) return undefined;

    const uniqueTextures = new Set(faceTextures.values());
    if (uniqueTextures.size === 1) {
      const key = registerTerrainTexture(ctx, [...uniqueTextures][0]!);
      if (key === undefined) return undefined;
      materials["*"] = { texture: key, render_method: "alpha_test" };
    } else {
      for (const [face, id] of faceTextures) {
        const key = registerTerrainTexture(ctx, id);
        if (key === undefined) continue;
        materials[face] = { texture: key, render_method: "alpha_test" };
      }
      // Bedrock needs a wildcard fallback.
      const firstKey = Object.values(materials)[0];
      if (firstKey !== undefined) materials["*"] = firstKey;
    }
    return {
      name,
      geometry: { identifier: "minecraft:geometry.full_block" },
      material_instances: materials,
    };
  }

  // Non-cube model → convert to a custom block geometry with a stitched atlas.
  const textureIds = new Set<string>();
  for (const element of elements) {
    for (const face of Object.values(element.faces ?? {})) {
      const id = resolveTextureRef(resolved.textures, face.texture);
      if (id !== undefined) textureIds.add(id);
    }
  }
  if (textureIds.size === 0) return undefined;

  const images = new Map<string, RgbaImage>();
  for (const id of textureIds) {
    const texPath = ctx.java.assetPath("textures", id, ".png");
    const image = decodeCached(ctx.java.read.bind(ctx.java), texPath, ctx.textureCache);
    if (image === undefined) continue;
    let img = image;
    if (img.height > img.width && ctx.java.has(texPath + ".mcmeta")) img = firstFrame(img);
    images.set(id, img);
  }
  if (images.size === 0) return undefined;

  const atlas = buildAtlas(images);
  alphaBleed(atlas.image);
  const atlasPath = `textures/geyser_custom/blocks/${name}`;
  ctx.bedrock.write(atlasPath + ".png", encodePng(atlas.image));
  const textureKey = registerTerrainTextureRaw(ctx, `gcb_${name}`, atlasPath);

  const geometryId = `geometry.geyser_custom.block_${name}`;
  const faceTexture = (element: JavaElement, faceName: JavaFaceName) => {
    const face = element.faces?.[faceName];
    if (face === undefined) return undefined;
    const id = resolveTextureRef(resolved.textures, face.texture);
    return id !== undefined ? atlas.placements.get(id) : undefined;
  };
  const geo = buildGeometry(geometryId, elements, faceTexture, {
    width: atlas.image.width,
    height: atlas.image.height,
  });
  // Blocks don't need the attachable bone chain, but the extra bones are harmless.
  ctx.bedrock.writeJson(fitFilePath("models/blocks/geyser_custom/", name, ".geo.json"), geo.geometry);
  ctx.report.approximated(
    "blocks",
    modelId,
    "non-cube block model converted with item-style geometry math — verify orientation in-game",
  );

  return {
    name,
    geometry: { identifier: geometryId },
    material_instances: { "*": { texture: textureKey, render_method: "alpha_test" } },
  };
}

/** Copy a java texture into the pack and register it in terrain_texture.json. */
function registerTerrainTexture(ctx: ConversionContext, textureId: string): string | undefined {
  const textureName = fitPathName(safeName(textureId), BLOCK_TEXTURE_PATH_RESERVED);
  const key = `gcb_${textureName}`;
  if (ctx.terrainTextures.has(key)) return key;
  const texPath = ctx.java.assetPath("textures", textureId, ".png");
  const image = decodeCached(ctx.java.read.bind(ctx.java), texPath, ctx.textureCache);
  if (image === undefined) return undefined;
  let img = image;
  if (img.height > img.width && ctx.java.has(texPath + ".mcmeta")) {
    img = firstFrame(img);
  }
  alphaBleed(img);
  const out = `textures/geyser_custom/blocks/${textureName}`;
  ctx.bedrock.write(out + ".png", encodePng(img));
  ctx.terrainTextures.set(key, { textures: out });
  return key;
}

function registerTerrainTextureRaw(ctx: ConversionContext, key: string, path: string): string {
  ctx.terrainTextures.set(key, { textures: path });
  return key;
}
