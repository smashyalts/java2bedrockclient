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
import { parseResourceLocation } from "../../java/javaPack.js";
import type { JavaElement, JavaFaceName } from "../../java/model.js";

/**
 * Custom blocks. Oraxen / ItemsAdder / Nexo implement custom blocks by
 * overriding the blockstates of "mechanic" vanilla blocks (note_block,
 * tripwire, mushroom blocks) — each state combination renders a custom model.
 * We convert those blockstate variants into Geyser custom block mappings
 * (format_version 1) with per-state overrides, plus the Bedrock-side
 * geometry + terrain_texture entries.
 */

/** Vanilla blocks plugins repurpose for custom blocks. */
const MECHANIC_BLOCKS = [
  "note_block",
  "tripwire",
  "mushroom_stem",
  "brown_mushroom_block",
  "red_mushroom_block",
  "cave_vines",
  "cave_vines_plant",
  "chorus_plant",
  "sugar_cane",
];

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
    for (const block of MECHANIC_BLOCKS) {
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
        convertBlockstates(ctx, block, path, state.variants);
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
    overrides[normalizeStateKey(stateKey)] = def;
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

/** Blockstate keys keep Java's prop=value,prop=value format; "" = default state. */
function normalizeStateKey(key: string): string {
  return key.trim();
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
  const name = safeName(modelId);
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
  ctx.bedrock.writeJson(`models/blocks/geyser_custom/${name}.geo.json`, geo.geometry);
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
  const key = `gcb_${safeName(textureId)}`;
  if (ctx.terrainTextures.has(key)) return key;
  const texPath = ctx.java.assetPath("textures", textureId, ".png");
  const image = decodeCached(ctx.java.read.bind(ctx.java), texPath, ctx.textureCache);
  if (image === undefined) return undefined;
  let img = image;
  if (img.height > img.width && ctx.java.has(texPath + ".mcmeta")) {
    img = firstFrame(img);
  }
  alphaBleed(img);
  const out = `textures/geyser_custom/blocks/${safeName(textureId)}`;
  ctx.bedrock.write(out + ".png", encodePng(img));
  ctx.terrainTextures.set(key, { textures: out });
  return key;
}

function registerTerrainTextureRaw(ctx: ConversionContext, key: string, path: string): string {
  ctx.terrainTextures.set(key, { textures: path });
  return key;
}
